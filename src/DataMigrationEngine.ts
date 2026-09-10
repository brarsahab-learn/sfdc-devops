import * as fs from "fs";
import * as path from "path";
import { execSf } from "./SfCli";
import {
    DmConfig,
    DmObjectConfig,
    TrackingFile,
    readTracking,
    writeTracking,
    appendHistoryEntry,
    writeLastRunLog,
    ensureDmDirs,
    safeOrgName,
} from "./DataMigrationConfig";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface DmRunController {
    pause(): void;
    resume(): void;
    skipObject(): void;
    cancel(): void;
    readonly state: "running" | "paused" | "cancelled" | "done";
}

export interface DmProgressEvent {
    phase: "load" | "pull";
    currentObject: string;
    objectIndex: number;
    objectCount: number;
    batchIndex: number;
    batchCount: number;
    recordsDone: number;
    recordsTotal: number;
    recordsCreated: number;
    recordsFailed: number;
    recordsSkipped: number;
    objectStatuses: {
        sobject: string;
        status: "done" | "running" | "pending" | "skipped";
        created: number;
        total: number;
    }[];
    elapsedMs: number;
    estimatedRemainingMs: number;
}

export interface DmRunOptions {
    dryRun?: boolean;
    dryRunSampleSize?: number;
    objectFilter?: string[];
}

// Internal controller shape that exposes _skip bookkeeping without polluting the public type
interface ControllerInternal extends DmRunController {
    _skip: boolean;
    _consumeSkip(): boolean;
    _setState(s: "running" | "paused" | "cancelled" | "done"): void;
}

// ---------------------------------------------------------------------------
// makeController
// ---------------------------------------------------------------------------

export function makeController(): DmRunController {
    let _state: "running" | "paused" | "cancelled" | "done" = "running";
    let _skip = false;

    const ctrl: ControllerInternal = {
        pause()  { if (_state === "running")  { _state = "paused";    } },
        resume() { if (_state === "paused")   { _state = "running";   } },
        cancel() { _state = "cancelled"; },
        skipObject() { _skip = true; },
        get state() { return _state; },
        get _skip() { return _skip; },
        set _skip(v: boolean) { _skip = v; },
        _consumeSkip() { const v = _skip; _skip = false; return v; },
        _setState(s) { _state = s; },
    };

    return ctrl;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type LogFn   = (text: string, level: "info" | "success" | "warn" | "error") => void;
type ProgFn  = (event: DmProgressEvent) => void;

function asInternal(ctrl: DmRunController): ControllerInternal {
    return ctrl as unknown as ControllerInternal;
}

/** Read controller state through a function call so TS cannot narrow it across loop iterations. */
function stateOf(ctrl: DmRunController): "running" | "paused" | "cancelled" | "done" {
    return ctrl.state;
}

function activeObjects(config: DmConfig): DmObjectConfig[] {
    return config.objects.filter(o => o.active).sort((a, b) => a.order - b.order);
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForResume(ctrl: DmRunController, onLog: LogFn): Promise<void> {
    onLog("⏸ Paused — waiting for resume...", "info");
    while (ctrl.state === "paused") {
        await sleep(500);
    }
}

function resolvedSeedDir(workspaceRoot: string, config: DmConfig, options?: DmRunOptions): string {
    if (options?.dryRun) {
        return path.join(workspaceRoot, ".git", "sf-devops-dm", "dryrun", "seed");
    }
    return path.resolve(workspaceRoot, config.seedDir);
}

function now(): string {
    return new Date().toISOString();
}

function csvEscape(val: string): string {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

/** Renders a per-object load summary that distinguishes genuine new records from upsert updates
 *  and from records that needed no work at all — plain "0 created" reads as a failure even when
 *  every record already existed correctly in the target org (e.g. a re-run after a prior success,
 *  or an idempotent upsert that only matched existing records). */
export function summarizeObjectResult(status: { created: number; updated: number; alreadyDone: number; total: number; failed?: number; skipped?: number }): string {
    const { created, updated, alreadyDone, total, failed = 0, skipped = 0 } = status;
    const parts: string[] = [];
    if (created > 0)    { parts.push(`${created} created`); }
    if (updated > 0)    { parts.push(`${updated} updated`); }
    if (alreadyDone > 0){ parts.push(`${alreadyDone} already up to date`); }
    if (failed > 0)     { parts.push(`${failed} failed ✗`); }
    if (skipped > 0)    { parts.push(`${skipped} skipped`); }
    if (parts.length === 0) {
        return total > 0 ? "0 processed" : "0 records";
    }
    return parts.join(", ");
}

/** Extract the offending field name from a Salesforce error string. */
function extractBadFieldName(msg: string): string | null {
    const patterns = [
        /No such column '([^']+)'/i,
        /INVALID_FIELD[^:]*:[^[]*\[([^\]]+)\]/i,
        /Unknown field:\s*([^\s,\n]+)/i,
        /field not readable:\s*([^\s,]+)/i,
    ];
    for (const re of patterns) {
        const m = msg.match(re);
        if (m) { return m[1].trim(); }
    }
    return null;
}

/** Remove a field from a SOQL SELECT clause. Returns null if nothing is left to select. */
function stripFieldFromQuery(query: string, field: string): string | null {
    const m = query.match(/^(SELECT\s+)([\s\S]+?)(\s+FROM\b[\s\S]*)$/i);
    if (!m) { return null; }
    const fields = m[2].split(",").map(f => f.trim()).filter(
        f => f.toLowerCase() !== field.toLowerCase() && f !== ""
    );
    if (fields.length === 0) { return null; }
    return `${m[1]}${fields.join(", ")}${m[3]}`;
}


/**
 * Parse a Salesforce CLI error message and return a user-friendly field-level explanation.
 * Returns null if the error is not field-related.
 */
function parseFieldError(sobject: string, raw: string): string | null {
    // "No such column 'FieldName__c' on entity 'SObject'"
    const colMatch = raw.match(/No such column '([^']+)'/i);
    if (colMatch) {
        return `Field '${colMatch[1]}' does not exist on ${sobject}. Check your SOQL query — remove or correct this field name.`;
    }
    // "INVALID_FIELD: ...: [FieldName__c]"
    const invFieldBracket = raw.match(/INVALID_FIELD[^:]*:.*?\[([^\]]+)\]/i);
    if (invFieldBracket) {
        return `Invalid field '${invFieldBracket[1]}' on ${sobject}. Verify the API name in your SOQL query.`;
    }
    // "INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: FieldA__c, FieldB__c"
    const insertUpdate = raw.match(/INVALID_FIELD_FOR_INSERT_UPDATE[^:]*:.*?fields:\s*([^\n.]+)/i);
    if (insertUpdate) {
        return `Field(s) not writable on ${sobject}: ${insertUpdate[1].trim()}. These fields may be auto-populated by Salesforce or read-only — remove them from your data file.`;
    }
    // "field not readable: FieldName__c"
    const notReadable = raw.match(/field not readable:\s*([^\s,]+)/i);
    if (notReadable) {
        return `Field '${notReadable[1]}' is not readable on ${sobject}. Check FLS/profile permissions or remove it from your SOQL query.`;
    }
    // "Unknown field: FieldName__c"
    const unknown = raw.match(/Unknown field:\s*([^\s,\n]+)/i);
    if (unknown) {
        return `Unknown field '${unknown[1]}' on ${sobject}. The field may have been deleted or renamed.`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// pullData helpers
// ---------------------------------------------------------------------------

export type RefField = { field: string; referenceTo: string[]; relationshipName: string };

async function getReferenceFields(
    sobject: string,
    org: string,
    workspaceRoot: string,
): Promise<RefField[]> {
    try {
        const { stdout } = await execSf(
            ["sobject", "describe", "--sobject", sobject, "--target-org", org, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        const fields: any[] = parsed?.result?.fields ?? [];
        return fields
            .filter(f => f.type === "reference" && Array.isArray(f.referenceTo) && f.referenceTo.length > 0)
            .map(f => ({
                field:            f.name           as string,
                referenceTo:      f.referenceTo    as string[],
                relationshipName: (f.relationshipName ?? (f.name as string).replace(/Id$/, "")) as string,
            }));
    } catch {
        return [];
    }
}

async function resolveRecordTypes(
    ids: string[],
    org: string,
    workspaceRoot: string,
): Promise<Map<string, string>> {
    if (ids.length === 0) { return new Map(); }
    const idList = ids.map(id => `'${id}'`).join(",");
    try {
        const { stdout } = await execSf(
            ["data", "query",
             "--query", `SELECT Id, DeveloperName FROM RecordType WHERE Id IN (${idList})`,
             "--target-org", org,
             "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        const records: any[] = parsed?.result?.records ?? [];
        return new Map(records.map(r => [r.Id as string, r.DeveloperName as string]));
    } catch {
        return new Map();
    }
}

// ---------------------------------------------------------------------------
// pullData
// ---------------------------------------------------------------------------

export async function pullData(
    sourceOrg: string,
    workspaceRoot: string,
    config: DmConfig,
    onLog: LogFn,
    onProgress: ProgFn,
    controller: DmRunController,
    options?: DmRunOptions,
): Promise<{ pulled: number; objects: string[] }> {
    const ctrl = asInternal(controller);
    const objects = activeObjects(config);
    const seedDir = resolvedSeedDir(workspaceRoot, config, options);
    const startMs = Date.now();

    ensureDmDirs(workspaceRoot, config.seedDir);
    fs.mkdirSync(seedDir, { recursive: true });

    const pulledObjects: string[] = [];
    const dependencyGraph: Record<string, string[]> = {};
    const referenceFieldsMap: Record<string, RefField[]> = {};

    for (let i = 0; i < objects.length; i++) {
        if (ctrl.state === "cancelled") { break; }

        const obj = objects[i];
        onLog(`Pulling ${obj.sobject} (${i + 1}/${objects.length})...`, "info");

        let query = obj.query?.trim() || `SELECT Id FROM ${obj.sobject}`;
        const selectPart = query.match(/^SELECT\s+([\s\S]+?)\s+FROM\b/i)?.[1] ?? "";
        const topFields = selectPart.split(",").map(f => f.trim().split(/\s+/)[0].toLowerCase());
        if (!topFields.includes("id")) {
            query = query.replace(/^SELECT\s+/i, "SELECT Id, ");
        }
        if (options?.dryRun && !/LIMIT\s+\d+/i.test(query)) {
            query += ` LIMIT ${options.dryRunSampleSize ?? 5}`;
        }

        let records: Record<string, any>[] = [];
        let pullSuccess = false;

        for (let attempt = 0; attempt <= 20; attempt++) {
            let rawMsg = "";
            try {
                const { stdout } = await execSf(
                    ["data", "query", "--query", query, "--target-org", sourceOrg, "--json"],
                    { cwd: workspaceRoot, timeout: 300_000, maxBuffer: 100 * 1024 * 1024 },
                );
                const parsed = JSON.parse(stdout);
                if (parsed.status !== 0) {
                    rawMsg = String(parsed.message ?? "unknown error");
                } else {
                    const raw: any[] = parsed?.result?.records ?? [];
                    records = raw.map(({ attributes: _a, ...rest }) => rest);
                    pullSuccess = true;
                    break;
                }
            } catch (e: any) {
                const rawOut: string = e?.stdout ?? "";
                try {
                    const p = JSON.parse(rawOut);
                    rawMsg = String(p?.message ?? p?.result?.message ?? e.message ?? String(e));
                } catch {
                    rawMsg = String(e?.message ?? String(e));
                }
            }

            if (rawMsg) {
                const badField = extractBadFieldName(rawMsg);
                if (badField && attempt < 20) {
                    const healed = stripFieldFromQuery(query, badField);
                    if (healed && healed !== query) {
                        onLog(`⚠️  Auto-removed unknown field '${badField}' from ${obj.sobject} SOQL — retrying…`, "warn");
                        query = healed;
                        continue;
                    }
                }
                onLog(`Pull failed for ${obj.sobject}: ${rawMsg}`, "error");
                const fieldHint = parseFieldError(obj.sobject, rawMsg);
                if (fieldHint) { onLog(`  → ${fieldHint}`, "warn"); }
                break;
            }
        }

        if (!pullSuccess) {
            const elapsed = Date.now() - startMs;
            onProgress({
                phase: "pull", currentObject: obj.sobject,
                objectIndex: i + 1, objectCount: objects.length,
                batchIndex: 1, batchCount: 1,
                recordsDone: i + 1, recordsTotal: objects.length,
                recordsCreated: pulledObjects.length,
                recordsFailed: (i + 1) - pulledObjects.length,
                recordsSkipped: 0,
                objectStatuses: objects.map((o, idx) => ({
                    sobject: o.sobject,
                    status: idx < i ? "done" as const : idx === i ? "skipped" as const : "pending" as const,
                    created: 0, total: 1,
                })),
                elapsedMs: elapsed, estimatedRemainingMs: 0,
            });
            continue;
        }

        if (!options?.dryRun) {
            const rtIds = [...new Set(
                records.filter(r => r.RecordTypeId && typeof r.RecordTypeId === "string")
                       .map(r => r.RecordTypeId as string)
            )];
            if (rtIds.length > 0) {
                const rtMap = await resolveRecordTypes(rtIds, sourceOrg, workspaceRoot);
                for (const record of records) {
                    if (record.RecordTypeId && rtMap.has(record.RecordTypeId)) {
                        record.RecordTypeId = `__RecordType__${rtMap.get(record.RecordTypeId)}`;
                    }
                }
            }
        }

        const seedFile = path.join(seedDir, `${obj.sobject}.json`);
        fs.writeFileSync(seedFile, JSON.stringify({ records }, null, 2), "utf-8");
        onLog(`✓ Pulled ${obj.sobject}: ${records.length} record${records.length !== 1 ? "s" : ""}`, "success");
        pulledObjects.push(obj.sobject);

        if (!options?.dryRun) {
            const refFields = await getReferenceFields(obj.sobject, sourceOrg, workspaceRoot);
            referenceFieldsMap[obj.sobject] = refFields;
            const deps = [...new Set(
                refFields
                    .flatMap(f => f.referenceTo)
                    .filter(t => objects.some(o => o.sobject === t))
            )];
            dependencyGraph[obj.sobject] = deps;
        } else {
            dependencyGraph[obj.sobject] = obj.dependsOn ?? [];
        }

        const elapsedMs = Date.now() - startMs;
        const remaining = objects.length - (i + 1);
        const estimatedRemainingMs = i > 0 ? Math.round((elapsedMs / (i + 1)) * remaining) : 0;
        onProgress({
            phase: "pull", currentObject: obj.sobject,
            objectIndex: i + 1, objectCount: objects.length,
            batchIndex: 1, batchCount: 1,
            recordsDone: i + 1, recordsTotal: objects.length,
            recordsCreated: pulledObjects.length,
            recordsFailed: (i + 1) - pulledObjects.length,
            recordsSkipped: 0,
            objectStatuses: objects.map((o, idx) => ({
                sobject: o.sobject,
                status: idx < i ? "done" as const : idx === i ? "running" as const : "pending" as const,
                created: idx <= i ? 1 : 0, total: 1,
            })),
            elapsedMs, estimatedRemainingMs,
        });
    }

    if (!options?.dryRun) {
        const planPath = path.join(seedDir, "plan.json");
        fs.writeFileSync(planPath, JSON.stringify({
            generatedAt: now(),
            sourceOrg,
            objects: pulledObjects,
            dependencies: dependencyGraph,
            referenceFields: referenceFieldsMap,
        }, null, 2), "utf-8");
    }

    return { pulled: pulledObjects.length, objects: pulledObjects };
}


// ---------------------------------------------------------------------------
// checkExternalId
// ---------------------------------------------------------------------------

export async function checkExternalId(
    targetOrg: string,
    sobject: string,
    workspaceRoot: string,
    onLog: LogFn,
): Promise<string | null> {
    onLog(`Checking external ID field on ${sobject}...`, "info");
    try {
        const { stdout } = await execSf(
            ["sobject", "describe", "--sobject", sobject, "--target-org", targetOrg, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        const fields: any[] = parsed?.result?.fields ?? [];

        // Only fields explicitly flagged externalId: true can be used as SF upsert keys.
        // Among those, prefer one matching our naming conventions (any namespace prefix,
        // including multi-segment like ns1__ns2__External_Id__c, and both single/double
        // underscore separators: ExternalId__c, External_Id__c, External__Id__c).
        const extIdFields = fields.filter(f => f.externalId === true);
        if (extIdFields.length === 0) {
            onLog(`ℹ  No ExternalId field found on ${sobject}`, "info");
            return null;
        }
        const preferred = extIdFields.find(f =>
            /^(?:\w+__)*External_?_?Id__c$/i.test(f.name)
        ) ?? extIdFields[0];
        onLog(`✓ ExternalId field on ${sobject}: ${preferred.name}`, "success");
        return preferred.name as string;
    } catch (e: any) {
        onLog(`Describe failed for ${sobject}: ${e?.message ?? String(e)}`, "warn");
        return null;
    }
}

// ---------------------------------------------------------------------------
// Automation control — opt-in (config.disableAutomationDuringLoad). Before a load, upsert a
// per-running-user override of the DataMigrationControls__c hierarchy custom setting so
// triggers/flows/validation rules/etc. don't fire while the bulk upsert runs, then put it back
// exactly as it was (or remove it, if we created it) once the load ends — success, failure, or
// cancel all go through the same restore path in loadData's finally block.
// ---------------------------------------------------------------------------

const AUTOMATION_CONTROL_SOBJECT = "DataMigrationControls__c";
const AUTOMATION_CONTROL_FIELDS = [
    "Disable_Emails_Notifications__c",
    "Disable_Flows__c",
    "Disable_Lookup_Filters__c",
    "Disable_Notification_Flows__c",
    "Disable_Triggers__c",
    "Disable_Validation_Rules__c",
];

interface AutomationControlState {
    userId: string;
    // DataMigrationControls__c (hierarchy custom setting) — undefined if it couldn't be set up.
    customSetting?: {
        recordId: string;
        created: boolean; // true: we inserted this override — delete it on restore.
                           // false: it already existed — restore its original field values.
        originalValues?: Record<string, boolean>;
    };
    // User.Skip_Lookup_Filters__c on the running user's own record — the User record always
    // exists (unlike the hierarchy custom setting), so this is just save-then-restore, no
    // create/delete. undefined if it couldn't be read/set (field missing, no access, etc.).
    userLookupFilters?: { originalValue: boolean };
}

export async function getRunningUserId(targetOrg: string, workspaceRoot: string): Promise<string | null> {
    try {
        const { stdout: orgInfo } = await execSf(
            ["org", "display", "--target-org", targetOrg, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const username = JSON.parse(orgInfo)?.result?.username;
        if (typeof username !== "string" || !username) { return null; }
        const { stdout } = await execSf(
            ["data", "query", "--query", `SELECT Id FROM User WHERE Username = '${username.replace(/'/g, "\\'")}'`,
             "--target-org", targetOrg, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const records: any[] = JSON.parse(stdout)?.result?.records ?? [];
        return (records[0]?.Id as string) ?? null;
    } catch {
        return null;
    }
}

/** Sets every field in AUTOMATION_CONTROL_FIELDS to true on the running user's override of
 *  DataMigrationControls__c, creating that override if none exists yet. Returns enough state to
 *  undo this exactly via restoreAutomationControl — or null if it couldn't be set up at all
 *  (missing object/fields, no access, user not resolvable), in which case the load proceeds
 *  without automation control rather than failing outright. */
export async function enableAutomationControl(
    targetOrg: string,
    workspaceRoot: string,
    emit: LogFn,
): Promise<AutomationControlState | null> {
    const userId = await getRunningUserId(targetOrg, workspaceRoot);
    if (!userId) {
        emit(`⚠ Could not resolve the running user in ${targetOrg} — skipping automation control`, "warn");
        return null;
    }

    const state: AutomationControlState = { userId };

    try {
        const { stdout } = await execSf(
            ["data", "query", "--query",
             `SELECT Id, ${AUTOMATION_CONTROL_FIELDS.join(", ")} FROM ${AUTOMATION_CONTROL_SOBJECT} WHERE SetupOwnerId = '${userId}'`,
             "--target-org", targetOrg, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const existing = (JSON.parse(stdout)?.result?.records ?? [])[0];
        const trueValues = AUTOMATION_CONTROL_FIELDS.map(f => `${f}=true`).join(" ");

        if (existing) {
            await execSf(
                ["data", "update", "record", "--sobject", AUTOMATION_CONTROL_SOBJECT,
                 "--record-id", existing.Id, "--values", trueValues, "--target-org", targetOrg, "--json"],
                { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
            );
            const originalValues: Record<string, boolean> = {};
            for (const f of AUTOMATION_CONTROL_FIELDS) { originalValues[f] = existing[f] === true; }
            emit(`✓ Automation disabled for load — existing ${AUTOMATION_CONTROL_SOBJECT} override for the running user updated (original values will be restored after)`, "success");
            state.customSetting = { recordId: existing.Id as string, created: false, originalValues };
        } else {
            const { stdout: createOut } = await execSf(
                ["data", "create", "record", "--sobject", AUTOMATION_CONTROL_SOBJECT,
                 "--values", `SetupOwnerId=${userId} ${trueValues}`, "--target-org", targetOrg, "--json"],
                { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
            );
            const newId = JSON.parse(createOut)?.result?.id;
            if (typeof newId !== "string" || !newId) { throw new Error("create record returned no id"); }
            emit(`✓ Automation disabled for load — created a ${AUTOMATION_CONTROL_SOBJECT} override for the running user (will be removed after)`, "success");
            state.customSetting = { recordId: newId, created: true };
        }
    } catch (e: any) {
        emit(`⚠ Could not set up ${AUTOMATION_CONTROL_SOBJECT} for ${targetOrg}: ${e?.message ?? String(e)} — continuing without it`, "warn");
    }

    try {
        const { stdout } = await execSf(
            ["data", "query", "--query", `SELECT Skip_Lookup_Filters__c FROM User WHERE Id = '${userId}'`,
             "--target-org", targetOrg, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const userRecord = (JSON.parse(stdout)?.result?.records ?? [])[0];
        const originalValue = userRecord?.Skip_Lookup_Filters__c === true;
        await execSf(
            ["data", "update", "record", "--sobject", "User", "--record-id", userId,
             "--values", "Skip_Lookup_Filters__c=true", "--target-org", targetOrg, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
        );
        emit(`✓ Set Skip_Lookup_Filters__c=true on the running user (will be restored to ${originalValue} after)`, "success");
        state.userLookupFilters = { originalValue };
    } catch (e: any) {
        emit(`⚠ Could not set Skip_Lookup_Filters__c on the running user: ${e?.message ?? String(e)} — continuing without it`, "warn");
    }

    return (state.customSetting || state.userLookupFilters) ? state : null;
}

export async function restoreAutomationControl(
    targetOrg: string,
    workspaceRoot: string,
    state: AutomationControlState,
    emit: LogFn,
): Promise<void> {
    if (state.customSetting) {
        try {
            if (state.customSetting.created) {
                await execSf(
                    ["data", "delete", "record", "--sobject", AUTOMATION_CONTROL_SOBJECT,
                     "--record-id", state.customSetting.recordId, "--target-org", targetOrg, "--json"],
                    { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
                );
                emit(`✓ Removed the ${AUTOMATION_CONTROL_SOBJECT} override created for this load`, "success");
            } else if (state.customSetting.originalValues) {
                const restoreValues = AUTOMATION_CONTROL_FIELDS.map(f => `${f}=${state.customSetting!.originalValues![f]}`).join(" ");
                await execSf(
                    ["data", "update", "record", "--sobject", AUTOMATION_CONTROL_SOBJECT,
                     "--record-id", state.customSetting.recordId, "--values", restoreValues, "--target-org", targetOrg, "--json"],
                    { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
                );
                emit(`✓ Restored the running user's original ${AUTOMATION_CONTROL_SOBJECT} values`, "success");
            }
        } catch (e: any) {
            emit(`✗ Could not restore ${AUTOMATION_CONTROL_SOBJECT} after the load — check it manually in ${targetOrg}: ${e?.message ?? String(e)}`, "error");
        }
    }

    if (state.userLookupFilters) {
        try {
            await execSf(
                ["data", "update", "record", "--sobject", "User", "--record-id", state.userId,
                 "--values", `Skip_Lookup_Filters__c=${state.userLookupFilters.originalValue}`, "--target-org", targetOrg, "--json"],
                { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
            );
            emit(`✓ Restored Skip_Lookup_Filters__c to ${state.userLookupFilters.originalValue} on the running user`, "success");
        } catch (e: any) {
            emit(`✗ Could not restore Skip_Lookup_Filters__c on the running user — check it manually in ${targetOrg}: ${e?.message ?? String(e)}`, "error");
        }
    }
}

// ---------------------------------------------------------------------------
// Load data helpers
// ---------------------------------------------------------------------------

/** Minimal RFC4180 CSV parser — handles quoted fields with embedded commas, quotes, and
 *  newlines, which Bulk API 2.0's `sf__Error` column regularly contains (e.g. messages that
 *  themselves list comma-separated field names). Returns one object per data row, keyed by
 *  header. */
export function parseCsv(text: string): Record<string, string>[] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') { field += '"'; i++; }
                else { inQuotes = false; }
            } else {
                field += c;
            }
        } else if (c === '"') {
            inQuotes = true;
        } else if (c === ",") {
            row.push(field); field = "";
        } else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") { i++; }
            row.push(field); field = "";
            rows.push(row); row = [];
        } else {
            field += c;
        }
    }
    if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
    const nonEmptyRows = rows.filter(r => !(r.length === 1 && r[0] === ""));
    if (nonEmptyRows.length === 0) { return []; }
    const headers = nonEmptyRows[0];
    return nonEmptyRows.slice(1).map(r => {
        const obj: Record<string, string> = {};
        headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
        return obj;
    });
}

function buildUpsertCsv(
    records: Record<string, any>[],
    obj: DmObjectConfig,
    referenceFields: RefField[],
    objByName: Map<string, DmObjectConfig>,
): string {
    if (records.length === 0 || !obj.externalIdField) { return ""; }

    const lookupToRelCol = new Map<string, string>();
    for (const rf of referenceFields) {
        if (rf.field === "RecordTypeId") {
            lookupToRelCol.set("RecordTypeId", "RecordType.DeveloperName");
            continue;
        }
        const parentSobject = rf.referenceTo.find(t => objByName.has(t));
        if (!parentSobject) { continue; }
        const parentCfg = objByName.get(parentSobject);
        if (!parentCfg?.externalIdField) { continue; }
        lookupToRelCol.set(rf.field, `${rf.relationshipName}.${parentCfg.externalIdField}`);
    }

    const lookupFields = new Set(lookupToRelCol.keys());
    const directFields = new Set<string>();
    const relColsOrdered: string[] = [];
    const relColSet = new Set<string>();

    for (const record of records) {
        for (const key of Object.keys(record)) {
            if (key === "Id") { continue; }
            if (lookupFields.has(key)) {
                const relCol = lookupToRelCol.get(key)!;
                if (!relColSet.has(relCol)) { relColSet.add(relCol); relColsOrdered.push(relCol); }
            } else {
                directFields.add(key);
            }
        }
    }

    const headers = [obj.externalIdField, ...Array.from(directFields), ...relColsOrdered];
    const relColToLookupField = new Map<string, string>(
        [...lookupToRelCol.entries()].map(([k, v]) => [v, k])
    );

    const rows = records.map(record => {
        return headers.map(h => {
            if (h === obj.externalIdField) {
                return csvEscape(String(record.Id ?? ""));
            }
            if (relColSet.has(h)) {
                const lookupField = relColToLookupField.get(h);
                if (!lookupField) { return ""; }
                const raw = record[lookupField];
                if (!raw) { return ""; }
                if (lookupField === "RecordTypeId" && typeof raw === "string" && raw.startsWith("__RecordType__")) {
                    return csvEscape(raw.slice("__RecordType__".length));
                }
                return csvEscape(String(raw));
            }
            const val = record[h];
            if (val === null || val === undefined) { return ""; }
            return csvEscape(String(val));
        }).join(",");
    });

    return [headers.join(","), ...rows].join("\n");
}

/** Fetch both success and failure records from a completed Bulk API 2.0 job.
 * Returns null if the `sf data bulk results` call fails or produces no CSV paths.
 * Fixes the case where execSf throws for partial failures (non-zero exit) but some
 * records actually succeeded — the success CSV always has the full truth.
 */
async function fetchBulkJobAllResults(
    jobId: string,
    targetOrg: string,
    tmpDir: string,
    extField: string,
    emit: LogFn,
): Promise<{
    successes: { extIdVal: string; sfId: string; wasNewRecord: boolean }[];
    failures: { extIdVal: string; error: string }[];
} | null> {
    try {
        const { stdout } = await execSf(
            ["data", "bulk", "results", "--job-id", jobId, "--target-org", targetOrg, "--json"],
            { cwd: tmpDir, timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);

        const successes: { extIdVal: string; sfId: string; wasNewRecord: boolean }[] = [];
        const failures: { extIdVal: string; error: string }[] = [];

        const successFilePath: string | undefined = parsed?.result?.successFilePath;
        if (successFilePath) {
            const csvPath = path.isAbsolute(successFilePath) ? successFilePath : path.join(tmpDir, successFilePath);
            if (fs.existsSync(csvPath)) {
                for (const r of parseCsv(fs.readFileSync(csvPath, "utf-8"))) {
                    successes.push({
                        extIdVal: r[extField] ?? "",
                        sfId: r["sf__Id"] ?? r["Id"] ?? "",
                        wasNewRecord: r["sf__Created"] === "true",
                    });
                }
            } else {
                emit(`  ⚠ Bulk job ${jobId}: success-results file was reported but not found at ${csvPath}`, "warn");
            }
        }

        const failedFilePath: string | undefined = parsed?.result?.failedFilePath;
        if (failedFilePath) {
            const csvPath = path.isAbsolute(failedFilePath) ? failedFilePath : path.join(tmpDir, failedFilePath);
            if (fs.existsSync(csvPath)) {
                for (const r of parseCsv(fs.readFileSync(csvPath, "utf-8"))) {
                    failures.push({
                        extIdVal: r[extField] ?? "",
                        error: r["sf__Error"] || "Unknown error (see failed-records CSV)",
                    });
                }
            } else {
                emit(`  ⚠ Bulk job ${jobId}: failed-results file was reported but not found at ${csvPath}`, "warn");
            }
        }

        if (!successFilePath && !failedFilePath) {
            emit(`  ⚠ Bulk job ${jobId}: "sf data bulk results" returned no result file paths — real per-record errors unavailable. Raw response: ${stdout.slice(0, 300)}`, "warn");
        }

        for (const suffix of ["-success-records.csv", "-failed-records.csv", "-unprocessed-records.csv"]) {
            try { fs.unlinkSync(path.join(tmpDir, `${jobId}${suffix}`)); } catch { /* ignore */ }
        }

        return { successes, failures };
    } catch (e: any) {
        // Previously swallowed entirely — the caller fell back to the CLI's generic
        // "N records failed" summary with no explanation of why the detail fetch itself
        // failed (e.g. the job wasn't actually done yet, or auth expired mid-run).
        emit(`  ⚠ Could not fetch real per-record errors for bulk job ${jobId}: ${e?.message ?? String(e)}`, "warn");
        emit(`  → Run manually to inspect: sf data bulk results --job-id ${jobId} --target-org ${targetOrg}`, "info");
        return null;
    }
}

function readSeedRecords(seedDir: string, sobject: string): Record<string, any>[] {
    const fp = path.join(seedDir, `${sobject}.json`);
    if (!fs.existsSync(fp)) { return []; }
    try {
        const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
        return (raw?.records ?? (Array.isArray(raw) ? raw : [])) as Record<string, any>[];
    } catch {
        return [];
    }
}

/** Parse upsert/import result and extract created/failed counts + refId mapping.
 *
 * Handles two CLI result shapes:
 *   - sf data upsert bulk:  [{ id, success, created, errors[] }]  — NO referenceId in results;
 *                           use resultItems[] for positional tracking (same order as CSV rows).
 *   - sf data import tree:  [{ referenceId, id }]                 — use createdByRef map.
 */
export function parseImportResult(stdout: string): {
    created: string[];
    createdByRef: Map<string, string>;
    failed: { refId: string; error: string }[];
    resultItems: { sfId: string; success: boolean; error: string; wasNewRecord: boolean }[]; // full positional list
    limitException: boolean;
    jobId?: string; // Bulk API 2.0 job id — set whenever the CLI's own response has no
                     // per-record breakdown (both the "N records failed" top-level error, AND a
                     // fully-successful upsert with zero failures — see below), so the caller can
                     // fetch the real per-record results via `sf data bulk results`.
} {
    const created: string[] = [];
    const createdByRef = new Map<string, string>();
    const failed: { refId: string; error: string }[] = [];
    const resultItems: { sfId: string; success: boolean; error: string; wasNewRecord: boolean }[] = [];
    let limitException = false;

    try {
        const parsed = JSON.parse(stdout);

        // Top-level CLI error (e.g. bad flag, auth failure) has no `result` key at all — surface
        // its message instead of silently reporting "0 created, N failed" with no detail. For a
        // Bulk API 2.0 job that completed with failures, this is ALWAYS just the generic
        // "Job finished being processed but failed to process N records." — the real per-record
        // reasons live in a separate `sf data bulk results` call keyed by `data.jobId`.
        if (parsed?.result === undefined && typeof parsed?.message === "string") {
            const errStr = parsed.message as string;
            if (errStr.includes("LimitException")) { limitException = true; }
            failed.push({ refId: "", error: errStr });
            // Only the "N records failed" completion error attaches `data.jobId` directly. A
            // --wait timeout or a job that ended in state "Failed" throws a DIFFERENT top-level
            // error with no `data` at all — but its message/actions still mention the job id
            // (e.g. `... --job-id 750XX0000004CzYGAU`), so fall back to pulling it out of there.
            // Without this, those two cases never even attempt the real-error fetch below.
            const fromData = typeof parsed?.data?.jobId === "string" ? parsed.data.jobId : undefined;
            const searchText = [errStr, ...(Array.isArray(parsed?.actions) ? parsed.actions : [])].join(" ");
            const fromText = searchText.match(/\b(750[a-zA-Z0-9]{12,18})\b/)?.[1];
            const jobId = fromData ?? fromText;
            return { created, createdByRef, failed, resultItems, limitException, jobId };
        }

        const rawResults: unknown = parsed?.result?.results ?? parsed?.result ?? [];

        if (typeof rawResults === "string" && rawResults.includes("LimitException")) {
            limitException = true;
            return { created, createdByRef, failed, resultItems, limitException };
        }

        // A Bulk API 2.0 upsert that succeeds with ZERO failed records never gets a `results`
        // array at all — the CLI's whole `result` is just job-level counters:
        // { jobId, processedRecords, successfulRecords, failedRecords }. Treating that as "empty
        // items" (the old behavior) marked every record "failed: No result" despite Salesforce
        // having created/updated them correctly. Recognize this shape and surface its jobId so
        // the caller fetches the real per-record results (including each row's target Id) via
        // `sf data bulk results`, exactly as it already does for the partial-failure case.
        if (!Array.isArray(rawResults) && typeof (rawResults as any)?.jobId === "string"
            && typeof (rawResults as any)?.processedRecords === "number") {
            return { created, createdByRef, failed, resultItems, limitException, jobId: (rawResults as any).jobId };
        }

        const items: any[] = Array.isArray(rawResults) ? rawResults : [];
        for (const item of items) {
            const hasErrors = Array.isArray(item.errors) && item.errors.length > 0;
            const isSuccess =
                item.success === true ||
                item.created === true ||
                item.isCreated === true ||
                // sf data import tree shape: has an id but no explicit success flag
                (typeof item.id === "string" && item.id.length >= 15 && !hasErrors);

            if (isSuccess) {
                const sfId = (item.id as string) ?? "";
                const refId = (item.referenceId ?? item.refId ?? "") as string;
                created.push(sfId);
                if (refId) { createdByRef.set(refId, sfId); }
                // Bulk upsert reports `created: false` for a row that matched an existing
                // record and was updated rather than inserted. Import tree has no such concept
                // (every row it returns is a genuine new record) — item.created is absent there,
                // so this defaults to true.
                const wasNewRecord = item.created !== false;
                resultItems.push({ sfId, success: true, error: "", wasNewRecord });
            } else {
                const errText = hasErrors
                    ? (item.errors as any[]).map((e: any) => e.message ?? String(e)).join("; ")
                    : (item.message ?? item.error ?? "unknown");
                const errStr = String(errText) || "unknown";
                if (errStr.includes("LimitException")) { limitException = true; }
                const refId = (item.referenceId ?? item.refId ?? "") as string;
                failed.push({ refId, error: errStr });
                resultItems.push({ sfId: "", success: false, error: errStr, wasNewRecord: false });
            }
        }
    } catch {
        if (stdout.includes("LimitException")) { limitException = true; }
    }

    return { created, createdByRef, failed, resultItems, limitException };
}

function kahnSort(nodes: string[], deps: Record<string, string[]>): string[] {
    const indeg = new Map<string, number>(nodes.map(n => [n, 0]));
    for (const node of nodes) {
        for (const _dep of deps[node] ?? []) {
            indeg.set(node, (indeg.get(node) ?? 0) + 1);
        }
    }
    const queue = nodes.filter(n => (indeg.get(n) ?? 0) === 0);
    const result: string[] = [];
    while (queue.length > 0) {
        const node = queue.shift()!;
        result.push(node);
        for (const other of nodes) {
            if ((deps[other] ?? []).includes(node)) {
                const d = (indeg.get(other) ?? 1) - 1;
                indeg.set(other, d);
                if (d === 0) { queue.push(other); }
            }
        }
    }
    for (const n of nodes) { if (!result.includes(n)) { result.push(n); } }
    return result;
}

// ---------------------------------------------------------------------------
// loadData (main function)
// ---------------------------------------------------------------------------

/** Public entry point — wraps loadDataImpl with automation control (config.
 *  disableAutomationDuringLoad) so it's set up once before the load and torn down exactly once
 *  after, regardless of how loadDataImpl exits (success, thrown error, or an early return from
 *  cancellation). Keeping this as a thin wrapper avoids restructuring loadDataImpl's own control
 *  flow, which already returns early from several places. */
export async function loadData(
    targetOrg: string,
    workspaceRoot: string,
    config: DmConfig,
    onLog: LogFn,
    onProgress: ProgFn,
    controller: DmRunController,
    options?: DmRunOptions,
): Promise<{ loaded: number; failed: number; skipped: number; blocked: number }> {
    if (!config.disableAutomationDuringLoad || options?.dryRun) {
        return loadDataImpl(targetOrg, workspaceRoot, config, onLog, onProgress, controller, options);
    }
    const automationState = await enableAutomationControl(targetOrg, workspaceRoot, onLog);
    try {
        return await loadDataImpl(targetOrg, workspaceRoot, config, onLog, onProgress, controller, options);
    } finally {
        if (automationState) {
            await restoreAutomationControl(targetOrg, workspaceRoot, automationState, onLog);
        }
    }
}

async function loadDataImpl(
    targetOrg: string,
    workspaceRoot: string,
    config: DmConfig,
    onLog: LogFn,
    onProgress: ProgFn,
    controller: DmRunController,
    options?: DmRunOptions,
): Promise<{ loaded: number; failed: number; skipped: number; blocked: number }> {
    const ctrl    = asInternal(controller);
    const startMs = Date.now();
    const seedDir = resolvedSeedDir(workspaceRoot, config, options);
    const dryRun  = options?.dryRun ?? false;
    const logLines: string[] = [];
    const emit = (text: string, level: "info" | "success" | "warn" | "error" = "info") => {
        onLog(text, level);
        logLines.push(`[${level}] ${now()} ${text}`);
    };

    const tmpDir = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-load");
    fs.mkdirSync(tmpDir, { recursive: true });

    let planDeps: Record<string, string[]> = {};
    let planRefFields: Record<string, RefField[]> = {};
    const planPath = path.join(seedDir, "plan.json");
    if (fs.existsSync(planPath)) {
        try {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
            planDeps      = plan.dependencies    ?? {};
            planRefFields = plan.referenceFields ?? {};
        } catch { /* ignore */ }
    }

    const allActive = activeObjects(config);

    if (!dryRun) {
        emit(`Pre-flight: verifying ExternalId fields on ${allActive.length} object(s)…`, "info");
        let preflightOk = true;
        const chunks = chunkArray(allActive, 5);
        for (const chunk of chunks) {
            const results = await Promise.allSettled(
                chunk.map(obj => checkExternalId(targetOrg, obj.sobject, workspaceRoot, () => {}))
            );
            for (let j = 0; j < chunk.length; j++) {
                const obj = chunk[j];
                const r   = results[j];
                const found = r.status === "fulfilled" ? r.value : null;
                if (!found) {
                    emit(`✗ ${obj.sobject}: ExternalId field '${obj.externalIdField ?? "(none configured)"}' not found in target org`, "error");
                    preflightOk = false;
                } else {
                    obj.externalIdField = found;
                    emit(`✓ ${obj.sobject}: ExternalId field '${found}' verified`, "success");
                }
            }
        }
        if (!preflightOk) {
            emit("Pre-flight failed — configure ExternalId fields before loading", "error");
            ctrl._setState("done");
            return { loaded: 0, failed: 0, skipped: 0, blocked: 0 };
        }
    }

    const depGraph: Record<string, string[]> = {};
    for (const obj of allActive) {
        const planDep   = planDeps[obj.sobject] ?? [];
        const configDep = obj.dependsOn ?? [];
        depGraph[obj.sobject] = [...new Set([...planDep, ...configDep])].filter(
            d => allActive.some(o => o.sobject === d)
        );
    }
    const sortedNames = kahnSort(allActive.map(o => o.sobject), depGraph);
    const objectsToProcess = sortedNames
        .map(name => allActive.find(o => o.sobject === name)!)
        .filter(Boolean);

    emit(`Load order: ${objectsToProcess.map(o => o.sobject).join(" → ")}`, "info");

    const objByName = new Map<string, DmObjectConfig>(allActive.map(o => [o.sobject, o]));

    let objectList = objectsToProcess;
    if (options?.objectFilter && options.objectFilter.length > 0) {
        const needed = new Set<string>();
        const addWithDeps = (sobject: string) => {
            if (needed.has(sobject)) { return; }
            needed.add(sobject);
            for (const dep of depGraph[sobject] ?? []) { addWithDeps(dep); }
        };
        for (const s of options.objectFilter) { addWithDeps(s); }
        objectList = objectsToProcess.filter(o => needed.has(o.sobject));
    }

    let tracking = readTracking(workspaceRoot, targetOrg);
    let totalLoaded = 0, totalFailed = 0, totalSkipped = 0, totalBlocked = 0;

    const objStatusMap = new Map<string, { status: string; created: number; updated: number; alreadyDone: number; total: number; failed: number; skipped: number }>();
    for (const obj of objectList) {
        objStatusMap.set(obj.sobject, { status: "pending", created: 0, updated: 0, alreadyDone: 0, total: 0, failed: 0, skipped: 0 });
    }

    let cachedGrandTotal: number | null = null;
    const buildProgressEvent = (
        obj: DmObjectConfig,
        objIdx: number,
        batchIdx: number,
        batchCount: number,
        batchDone: number,
        _batchTotal: number,
    ): DmProgressEvent => {
        const elapsedMs = Date.now() - startMs;
        const recordsDone = totalLoaded + totalFailed + totalSkipped + totalBlocked + batchDone;
        if (cachedGrandTotal === null) {
            cachedGrandTotal = objectList.reduce((sum, o) => sum + readSeedRecords(seedDir, o.sobject).length, 0);
        }
        const grandTotal = cachedGrandTotal;
        const remaining = Math.max(0, grandTotal - recordsDone);
        const estimatedRemainingMs = recordsDone > 0 ? Math.round((elapsedMs / recordsDone) * remaining) : 0;
        return {
            phase: "load",
            currentObject: obj.sobject,
            objectIndex: objIdx + 1,
            objectCount: objectList.length,
            batchIndex: batchIdx + 1,
            batchCount,
            recordsDone,
            recordsTotal: grandTotal,
            recordsCreated: totalLoaded,
            recordsFailed: totalFailed,
            recordsSkipped: totalSkipped,
            objectStatuses: objectList.map(o => {
                const s = objStatusMap.get(o.sobject) ?? { status: "pending", created: 0, total: 0 };
                return { sobject: o.sobject, status: s.status as "done" | "running" | "pending" | "skipped", created: (s as any).created ?? 0, total: (s as any).total ?? 0 };
            }),
            elapsedMs,
            estimatedRemainingMs,
        };
    };

    for (let objIdx = 0; objIdx < objectList.length; objIdx++) {
        if (stateOf(ctrl) === "cancelled") { writeTracking(workspaceRoot, targetOrg, tracking); break; }
        if (stateOf(ctrl) === "paused")    { await waitForResume(controller, onLog); }

        const obj = objectList[objIdx];
        objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject)!, status: "running" });
        emit(`Loading ${obj.sobject} (${objIdx + 1}/${objectList.length})...`, "info");

        let refFields: RefField[] = planRefFields[obj.sobject] ?? [];
        if (refFields.length === 0 && !dryRun) {
            refFields = await getReferenceFields(obj.sobject, targetOrg, workspaceRoot);
        }

        const allRecords = readSeedRecords(seedDir, obj.sobject);
        if (allRecords.length === 0) {
            emit(`No seed records found for ${obj.sobject} — skipping`, "warn");
            objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject)!, status: "skipped" });
            continue;
        }

        if (!tracking[obj.sobject]) { tracking[obj.sobject] = {}; }
        objStatusMap.get(obj.sobject)!.total = allRecords.length;

        const batches = chunkArray(allRecords, config.batchSize);

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            if (stateOf(ctrl) === "cancelled") { writeTracking(workspaceRoot, targetOrg, tracking); return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked }; }
            if (stateOf(ctrl) === "paused")    { await waitForResume(controller, onLog); }
            if (ctrl._consumeSkip()) {
                for (const rec of batches.slice(batchIdx).flat()) {
                    const srcId = String(rec.Id ?? `${obj.sobject}_${batchIdx}`);
                    if (tracking[obj.sobject][srcId]?.status !== "created") {
                        tracking[obj.sobject][srcId] = { status: "skipped", at: now() };
                        totalSkipped++;
                        objStatusMap.get(obj.sobject)!.skipped++;
                    }
                }
                break;
            }

            const batch = batches[batchIdx];
            const toLoad: Record<string, any>[] = [];
            for (const rec of batch) {
                const srcId = String(rec.Id ?? "");
                if (tracking[obj.sobject][srcId]?.status === "created") {
                    objStatusMap.get(obj.sobject)!.alreadyDone++;
                } else {
                    toLoad.push(rec);
                }
            }

            if (toLoad.length === 0) {
                onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, 0, batch.length));
                continue;
            }

            if (dryRun) {
                emit(`[dry-run] Would upsert ${toLoad.length} record(s) for ${obj.sobject} batch ${batchIdx + 1}`, "info");
                for (const rec of toLoad) {
                    const srcId = String(rec.Id ?? "");
                    tracking[obj.sobject][srcId] = { status: "skipped", at: now() };
                    totalSkipped++;
                }
                onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, toLoad.length, batch.length));
                continue;
            }

            await loadBatch(
                obj, toLoad, targetOrg, workspaceRoot, tmpDir,
                tracking, refFields, objByName, emit,
                (created, updated, failed) => {
                    totalLoaded += created + updated;
                    totalFailed += failed;
                    const s = objStatusMap.get(obj.sobject)!;
                    s.created += created;
                    s.updated += updated;
                    s.failed  += failed;
                },
                config.batchSize,
            );

            writeTracking(workspaceRoot, targetOrg, tracking);
            onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, toLoad.length, batch.length));
        }

        writeTracking(workspaceRoot, targetOrg, tracking);
        objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject)!, status: "done" });
        emit(`✓ ${obj.sobject}: ${summarizeObjectResult(objStatusMap.get(obj.sobject)!)}`, "success");
    }

    const summaryParts = [`${totalLoaded} pushed`];
    if (totalFailed > 0)  { summaryParts.push(`${totalFailed} failed`); }
    if (totalSkipped > 0) { summaryParts.push(`${totalSkipped} skipped`); }
    if (totalBlocked > 0) { summaryParts.push(`${totalBlocked} blocked`); }
    emit(`─── Load complete: ${summaryParts.join(" · ")} ───`, totalFailed > 0 ? "warn" : "success");

    if (dryRun) {
        const reportPath = path.join(workspaceRoot, ".git", "sf-devops-dm", "dryrun", "report.json");
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: now(), targetOrg, totalLoaded, totalFailed, totalSkipped, totalBlocked }, null, 2), "utf-8");
    }

    writeLastRunLog(workspaceRoot, logLines);
    appendHistoryEntry(workspaceRoot, { at: now(), op: "load", targetOrg, dryRun, loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked });

    ctrl._setState("done");
    return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked };
}

// ---------------------------------------------------------------------------
// loadBatch — always-upsert via Bulk API 2.0 with relationship columns
// ---------------------------------------------------------------------------

async function loadBatch(
    obj: DmObjectConfig,
    records: Record<string, any>[],
    targetOrg: string,
    workspaceRoot: string,
    tmpDir: string,
    tracking: TrackingFile,
    referenceFields: RefField[],
    objByName: Map<string, DmObjectConfig>,
    emit: LogFn,
    onCount: (created: number, updated: number, failed: number) => void,
    maxBatchSize: number,
): Promise<void> {
    if (!obj.externalIdField) {
        emit(`✗ ${obj.sobject}: no externalIdField configured — skipping batch`, "error");
        onCount(0, 0, records.length);
        return;
    }

    if (records.length > maxBatchSize) {
        const half = Math.ceil(records.length / 2);
        await loadBatch(obj, records.slice(0, half), targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        await loadBatch(obj, records.slice(half),    targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        return;
    }

    const csv = buildUpsertCsv(records, obj, referenceFields, objByName);
    if (!csv) { return; }

    const csvPath = path.join(tmpDir, `${safeOrgName(obj.sobject)}-${Date.now()}.csv`);
    let stdout = "";
    let attemptFailed = false;

    try {
        fs.writeFileSync(csvPath, csv, "utf-8");
        const result = await execSf(
            ["data", "upsert", "bulk",
             "--sobject",     obj.sobject,
             "--external-id", obj.externalIdField,
             "--file",        csvPath,
             "--target-org",  targetOrg,
             "--wait",        "10",
             "--json"],
            { cwd: workspaceRoot, timeout: 180_000, maxBuffer: 50 * 1024 * 1024 },
        );
        stdout = result.stdout;
    } catch (e: any) {
        stdout = (e as any)?.stdout ?? "";
        attemptFailed = true;
    } finally {
        if (fs.existsSync(csvPath)) { try { fs.unlinkSync(csvPath); } catch { /* ignore */ } }
    }

    const parsedResult = parseImportResult(stdout);
    const { resultItems, limitException, jobId } = parsedResult;
    let failed = parsedResult.failed;

    if (jobId && obj.externalIdField) {
        const allResults = await fetchBulkJobAllResults(jobId, targetOrg, tmpDir, obj.externalIdField, emit);
        if (allResults) {
            const successByExtId = new Map(allResults.successes.map(s => [s.extIdVal, s]));
            const failureByExtId = new Map(allResults.failures.map(f => [f.extIdVal, f]));
            resultItems.length = 0;
            for (const record of records) {
                const extIdVal = String(record.Id ?? "");
                const success = successByExtId.get(extIdVal);
                const failure = failureByExtId.get(extIdVal);
                if (success) {
                    resultItems.push({ sfId: success.sfId, success: true, error: "", wasNewRecord: success.wasNewRecord });
                } else {
                    resultItems.push({ sfId: "", success: false, error: failure?.error ?? "Unknown error", wasNewRecord: false });
                }
            }
            if (resultItems.length > 0) { attemptFailed = false; failed = resultItems.filter(r => !r.success).map(r => ({ refId: "", error: r.error })); }
        }
    }

    if (limitException && records.length > 1) {
        const half = Math.ceil(records.length / 2);
        emit(`Governor limit hit for ${obj.sobject} batch of ${records.length} — splitting`, "warn");
        await loadBatch(obj, records.slice(0, half), targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        await loadBatch(obj, records.slice(half),    targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        return;
    }

    let batchCreated = 0, batchUpdated = 0, batchFailed = 0;
    if (resultItems.length > 0 || !attemptFailed) {
        for (let i = 0; i < records.length; i++) {
            const sourceId = String(records[i].Id ?? `unknown-${i}`);
            const posResult = resultItems[i];
            if (posResult?.success) {
                tracking[obj.sobject][sourceId] = { status: "created", id: posResult.sfId, at: now() };
                if (posResult.wasNewRecord) { batchCreated++; } else { batchUpdated++; }
            } else {
                const err = posResult?.error ?? (attemptFailed ? "Batch failed" : "No result");
                tracking[obj.sobject][sourceId] = { status: "failed", error: err, at: now() };
                batchFailed++;
            }
        }
        onCount(batchCreated, batchUpdated, batchFailed);
        if (batchFailed > 0) {
            const parts: string[] = [];
            if (batchCreated > 0) { parts.push(`${batchCreated} created`); }
            if (batchUpdated > 0) { parts.push(`${batchUpdated} updated`); }
            if (parts.length === 0) { parts.push("0 created"); }
            emit(`${obj.sobject}: ${parts.join(", ")}, ${batchFailed} failed in batch`, "warn");
            const seenErrors = new Set<string>();
            for (const r of resultItems.filter(r => !r.success)) {
                const hint = parseFieldError(obj.sobject, r.error);
                const msg  = hint ?? (r.error.length > 200 ? r.error.slice(0, 200) + "…" : r.error);
                if (msg && !seenErrors.has(msg)) {
                    seenErrors.add(msg);
                    emit(`  ${hint ? "→" : "✗"} ${msg}`, hint ? "warn" : "error");
                }
            }
        } else {
            const parts: string[] = [];
            if (batchCreated > 0) { parts.push(`${batchCreated} pushed ✓`); }
            if (batchUpdated > 0) { parts.push(`${batchUpdated} updated ✓`); }
            if (parts.length > 0) { emit(`  ${obj.sobject}: ${parts.join(", ")}`, "success"); }
        }
    } else {
        for (const record of records) {
            const sourceId = String(record.Id ?? "unknown");
            tracking[obj.sobject][sourceId] = { status: "failed", error: "No parseable result", at: now() };
        }
        onCount(0, 0, records.length);
        emit(`${obj.sobject}: batch failed — no parseable result`, "error");
    }
}

// ---------------------------------------------------------------------------
// autoSortByDependencies
// ---------------------------------------------------------------------------

export async function autoSortByDependencies(
    targetOrg: string,
    workspaceRoot: string,
    config: DmConfig,
    onLog: LogFn,
): Promise<DmConfig> {
    const objects = activeObjects(config);
    const sobjectNames = new Set(objects.map(o => o.sobject));

    // ------------------------------------------------------------------
    // Pass A: schema-based dependency discovery (5-concurrent)
    // ------------------------------------------------------------------
    const schemaDeps = new Map<string, Set<string>>();
    for (const o of objects) { schemaDeps.set(o.sobject, new Set()); }

    const describeChunks = chunkArray(objects, 5);
    for (const chunk of describeChunks) {
        const results = await Promise.allSettled(chunk.map(async obj => {
            try {
                const { stdout } = await execSf(
                    ["sobject", "describe", "--sobject", obj.sobject, "--target-org", targetOrg, "--json"],
                    { cwd: workspaceRoot, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
                );
                const parsed = JSON.parse(stdout);
                const fields: any[] = parsed?.result?.fields ?? [];
                const deps = new Set<string>();
                for (const f of fields) {
                    if (f.type === "reference" && Array.isArray(f.referenceTo)) {
                        for (const ref of f.referenceTo) {
                            if (sobjectNames.has(ref) && ref !== obj.sobject) {
                                deps.add(ref as string);
                            }
                        }
                    }
                }
                return { sobject: obj.sobject, deps };
            } catch {
                return { sobject: obj.sobject, deps: new Set<string>() };
            }
        }));

        for (const r of results) {
            if (r.status === "fulfilled") {
                schemaDeps.set(r.value.sobject, r.value.deps);
            }
        }
    }

    // ------------------------------------------------------------------
    // Final deps: use schema-based discovery
    // ------------------------------------------------------------------
    const finalDeps = schemaDeps;

    // ------------------------------------------------------------------
    // Topological sort — Kahn's algorithm
    // ------------------------------------------------------------------
    const inDegree = new Map<string, number>();
    for (const o of objects) { inDegree.set(o.sobject, 0); }
    // For each node, in-degree = number of dependencies (objects that must load before it)
    for (const o of objects) {
        for (const dep of finalDeps.get(o.sobject)!) {
            inDegree.set(o.sobject, (inDegree.get(o.sobject) ?? 0) + 1);
        }
    }

    const queue: string[] = [];
    for (const o of objects) {
        if ((inDegree.get(o.sobject) ?? 0) === 0) { queue.push(o.sobject); }
    }

    const sorted: string[] = [];
    const processed = new Set<string>();

    while (queue.length > 0) {
        const node = queue.shift()!;
        sorted.push(node);
        processed.add(node);

        // Find all nodes that depend on `node` and decrement their in-degree
        for (const o of objects) {
            if (finalDeps.get(o.sobject)?.has(node)) {
                const newDeg = (inDegree.get(o.sobject) ?? 0) - 1;
                inDegree.set(o.sobject, newDeg);
                if (newDeg === 0) { queue.push(o.sobject); }
            }
        }
    }

    // Nodes not processed = cycles — log and append in original order
    const cycleNodes = objects.filter(o => !processed.has(o.sobject));
    if (cycleNodes.length > 0) {
        onLog(`Warning: dependency cycles detected for [${cycleNodes.map(o => o.sobject).join(", ")}] — keeping original order`, "warn");
        for (const o of cycleNodes) { sorted.push(o.sobject); }
    }

    // ------------------------------------------------------------------
    // Rewrite config order and dependsOn
    // ------------------------------------------------------------------
    for (let i = 0; i < sorted.length; i++) {
        const sobject = sorted[i];
        const objCfg = config.objects.find(o => o.sobject === sobject);
        if (objCfg) {
            objCfg.order = i + 1;
            objCfg.dependsOn = Array.from(finalDeps.get(sobject) ?? []);
        }
    }

    onLog("✓ Dependency sort complete", "success");
    return config;
}

// ---------------------------------------------------------------------------
// rollbackData
// ---------------------------------------------------------------------------

export async function rollbackData(
    targetOrg: string,
    workspaceRoot: string,
    config: DmConfig,
    onLog: LogFn,
    options?: DmRunOptions,
): Promise<{ deleted: number; deleteFailed: number }> {
    const tracking = readTracking(workspaceRoot, targetOrg);
    const dryRun = options?.dryRun ?? false;
    const tmpDir = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-rollback");
    fs.mkdirSync(tmpDir, { recursive: true });

    // Reverse config order
    const objects = activeObjects(config).reverse();

    let deleted = 0;
    let deleteFailed = 0;

    for (const obj of objects) {
        const objTracking = tracking[obj.sobject] ?? {};
        const createdEntries = Object.entries(objTracking).filter(([, e]) => e.status === "created" && e.id);

        if (createdEntries.length === 0) { continue; }

        onLog(`Rolling back ${obj.sobject}: ${createdEntries.length} record(s)`, "info");

        if (dryRun) {
            onLog(`[dry-run] Would delete ${createdEntries.length} ${obj.sobject} records`, "info");
            continue;
        }

        // Write CSV of IDs
        const csvLines = ["Id", ...createdEntries.map(([, e]) => e.id!)];
        const csvPath = path.join(tmpDir, `${safeOrgName(obj.sobject)}-rollback-${Date.now()}.csv`);
        fs.writeFileSync(csvPath, csvLines.join("\n"), "utf-8");

        let objDeleted = 0;
        let objDeleteFailed = 0;

        try {
            const { stdout } = await execSf(
                ["data", "delete", "bulk",
                 "--sobject", obj.sobject,
                 "--file", csvPath,
                 "--target-org", targetOrg,
                 "--wait", "10",
                 "--json"],
                { cwd: workspaceRoot, timeout: 180_000, maxBuffer: 20 * 1024 * 1024 },
            );

            const parsed = JSON.parse(stdout);
            const results: any[] = parsed?.result?.results ?? [];
            for (const [idx, [refId,]] of createdEntries.entries()) {
                const r = results[idx];
                if (r?.success === true || r?.deleted === true) {
                    tracking[obj.sobject][refId] = { status: "deleted", at: now() };
                    objDeleted++;
                } else {
                    const err = (r?.errors ?? []).map((e: any) => e.message).join("; ") || "unknown";
                    tracking[obj.sobject][refId] = { status: "delete-failed", error: err, at: now() };
                    objDeleteFailed++;
                }
            }
        } catch (e: any) {
            onLog(`Delete bulk failed for ${obj.sobject}: ${e?.message ?? String(e)}`, "error");
            for (const [refId,] of createdEntries) {
                tracking[obj.sobject][refId] = { status: "delete-failed", error: e?.message ?? "execSf error", at: now() };
                objDeleteFailed++;
            }
        }

        deleted += objDeleted;
        deleteFailed += objDeleteFailed;

        fs.unlinkSync(csvPath);
        writeTracking(workspaceRoot, targetOrg, tracking);
        onLog(`✓ ${obj.sobject}: ${objDeleted} deleted`, "success");
    }

    // Clean up tmp dir if empty
    try { fs.rmdirSync(tmpDir); } catch { /* not empty or already gone */ }

    appendHistoryEntry(workspaceRoot, {
        at: now(),
        op: "rollback",
        targetOrg,
        dryRun,
        deleted,
        deleteFailed,
    });

    return { deleted, deleteFailed };
}

// ---------------------------------------------------------------------------
// listAvailableOrgs
// ---------------------------------------------------------------------------

export async function listAvailableOrgs(
    workspaceRoot: string,
): Promise<{ alias: string; username: string; isDevHub: boolean; connectedStatus: string }[]> {
    try {
        const { stdout } = await execSf(
            ["org", "list", "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        const nonScratch: any[] = parsed?.result?.nonScratchOrgs ?? [];
        const scratch: any[] = parsed?.result?.scratchOrgs ?? [];

        return [...nonScratch, ...scratch].map(org => ({
            alias: org.alias ?? org.username ?? "",
            username: org.username ?? "",
            isDevHub: org.isDevHub === true,
            connectedStatus: org.connectedStatus ?? org.status ?? "Unknown",
        }));
    } catch {
        return [];
    }
}
