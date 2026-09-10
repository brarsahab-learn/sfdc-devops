import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSf } from "./SfCli";
import { debugLog } from "./Log";
import {
    DmConfig,
    DmObjectConfig,
    TrackingFile,
    TrackingEntry,
    TrackingStatus,
    readTracking,
    writeTracking,
    appendHistoryEntry,
    writeLastRunLog,
    writeDmConfig,
    ensureDmDirs,
    dmBaseDir,
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

/** Count records in data JSON files exported by sf data export tree for a given sobject. */
function countExportedRecords(dir: string): number {
    let count = 0;
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json") || f.endsWith("-plan.json")) { continue; }
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
            count += Array.isArray(data.records) ? data.records.length : 0;
        }
    } catch { /* ignore */ }
    return count;
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
    const tmpRoot = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-pull");

    ensureDmDirs(workspaceRoot, config.seedDir);
    fs.mkdirSync(seedDir, { recursive: true });
    fs.mkdirSync(tmpRoot, { recursive: true });

    const startMs = Date.now();
    const pulledObjects: string[] = [];

    // Each object below is pulled with its OWN isolated `sf data export tree` call, so that
    // command's built-in cross-file @refId linking never sees other objects and just leaves
    // lookup fields as raw source-org Ids — those Ids don't exist in the target org and every
    // load then fails on FIELD_INTEGRITY_EXCEPTION / INVALID_CROSS_REFERENCE_KEY. We resolve
    // these ourselves once each parent's data is available (see resolveObjectLookupRefs below).
    const idMapsBySobject = new Map<string, Map<string, string>>();
    const refFieldsBySobject = new Map<string, { field: string; referenceTo: string[] }[]>();

    for (let i = 0; i < objects.length; i++) {
        if (ctrl.state === "cancelled") { break; }

        const obj = objects[i];
        onLog(`Pulling ${obj.sobject} (${i + 1}/${objects.length})...`, "info");

        let query = obj.query?.trim() || `SELECT Id FROM ${obj.sobject}`;

        // "Id" must be selected for every object — it's how we map this object's own records
        // back to their referenceId, which lets OTHER objects' lookups to this one resolve to
        // "@refId" instead of a raw source-org Id (see resolveObjectLookupRefs below).
        const selectMatch = query.match(/^SELECT\s+([\s\S]+?)\s+FROM\b/i);
        const topLevelFields = (selectMatch?.[1] ?? "").split(",").map(f => f.trim().split(/\s+/)[0]);
        if (!topLevelFields.some(f => f.toLowerCase() === "id")) {
            query = query.replace(/^SELECT\s+/i, "SELECT Id, ");
        }

        if (options?.dryRun && !/LIMIT\s+\d+/i.test(query)) {
            query += ` LIMIT ${options.dryRunSampleSize ?? 5}`;
        }

        const tmpDir = path.join(tmpRoot, `${safeOrgName(obj.sobject)}-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        // Auto-heal loop: retry after stripping unrecognised fields from SELECT
        for (let attempt = 0; attempt <= 20; attempt++) {
            let rawMsg = "";
            try {
                const { stdout } = await execSf(
                    ["data", "export", "tree", "--query", query, "--output-dir", tmpDir, "--plan",
                     "--target-org", sourceOrg, "--json"],
                    { cwd: workspaceRoot, timeout: 300_000, maxBuffer: 100 * 1024 * 1024 },
                );
                const parsed = JSON.parse(stdout);
                if (parsed.status !== 0) {
                    rawMsg = String(parsed.message ?? "unknown error");
                } else {
                    // Count records from exported files before moving
                    const recordCount = countExportedRecords(tmpDir);

                    // Move all output files from tmpDir to seedDir (overwriting existing)
                    for (const file of fs.readdirSync(tmpDir)) {
                        fs.copyFileSync(path.join(tmpDir, file), path.join(seedDir, file));
                        fs.unlinkSync(path.join(tmpDir, file));
                    }
                    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }

                    pulledObjects.push(obj.sobject);
                    idMapsBySobject.set(obj.sobject, buildIdToRefMap(seedDir, obj.sobject));

                    // Resolve this object's OWN lookups against every parent pulled so far
                    // (dependency order means most parents are already available). Any that
                    // reference a not-yet-pulled parent are caught by the final sweep below.
                    if (!options?.dryRun) {
                        const refFields = await getReferenceFields(obj.sobject, sourceOrg, workspaceRoot);
                        refFieldsBySobject.set(obj.sobject, refFields);
                        const { resolved } = resolveObjectLookupRefs(seedDir, obj.sobject, refFields, idMapsBySobject);
                        if (resolved > 0) {
                            onLog(`  → Resolved ${resolved} lookup reference(s) on ${obj.sobject} to @refId`, "info");
                        }
                    }

                    onLog(`✓ Pulled ${obj.sobject}: ${recordCount} record${recordCount !== 1 ? "s" : ""}`, "success");
                    break; // success
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
                        onLog(`⚠️  Auto-removed unknown field '${badField}' from ${obj.sobject} SOQL — field not found in org. Retrying…`, "warn");
                        query = healed;
                        // Clear tmpDir for retry
                        try { for (const f of fs.readdirSync(tmpDir)) { fs.unlinkSync(path.join(tmpDir, f)); } } catch { /* ignore */ }
                        continue;
                    }
                }
                onLog(`Pull failed for ${obj.sobject}: ${rawMsg}`, "error");
                const fieldHint = parseFieldError(obj.sobject, rawMsg);
                if (fieldHint) { onLog(`  → ${fieldHint}`, "warn"); }
                break;
            }
        }

        const elapsedMs = Date.now() - startMs;
        const recordsDone = i + 1;
        const remaining = objects.length - recordsDone;
        const estimatedRemainingMs = recordsDone > 0 ? Math.round((elapsedMs / recordsDone) * remaining) : 0;

        onProgress({
            phase: "pull",
            currentObject: obj.sobject,
            objectIndex: i + 1,
            objectCount: objects.length,
            batchIndex: 1,
            batchCount: 1,
            recordsDone,
            recordsTotal: objects.length,
            recordsCreated: pulledObjects.length,
            recordsFailed: recordsDone - pulledObjects.length,
            recordsSkipped: 0,
            objectStatuses: objects.map((o, idx) => ({
                sobject: o.sobject,
                status: idx < i ? "done" : idx === i ? "running" : "pending",
                created: idx < i ? 1 : 0,
                total: 1,
            })),
            elapsedMs,
            estimatedRemainingMs,
        });
    }

    // Final sweep: re-resolve every object's lookups now that ALL objects have been pulled —
    // catches a child pulled before its parent (out of dependency order), which the per-object
    // pass above couldn't resolve yet since that parent's id map didn't exist at the time.
    if (!options?.dryRun) {
        let totalResolved = 0;
        let totalUnresolved = 0;
        for (const sobject of pulledObjects) {
            const refFields = refFieldsBySobject.get(sobject) ?? [];
            const { resolved, unresolved } = resolveObjectLookupRefs(seedDir, sobject, refFields, idMapsBySobject);
            totalResolved += resolved;
            totalUnresolved += unresolved;
        }
        if (totalResolved > 0) {
            onLog(`✓ Resolved ${totalResolved} additional cross-object lookup reference(s) after all objects were pulled`, "success");
        }
        if (totalUnresolved > 0) {
            onLog(`⚠  ${totalUnresolved} lookup reference(s) point to a parent record that wasn't pulled (filtered out by its SOQL, or the object isn't in this migration) — those will load with their raw source-org Id and likely fail`, "warn");
        }
    }

    // Write a summary plan.json (not the sf export plan — our own manifest)
    if (!options?.dryRun) {
        const planPath = path.join(seedDir, "plan.json");
        fs.writeFileSync(planPath, JSON.stringify({
            generatedAt: now(),
            sourceOrg,
            objects: pulledObjects,
        }, null, 2), "utf-8");
    }

    return { pulled: pulledObjects.length, objects: pulledObjects };
}

/** Describe an object and return its lookup/master-detail fields with their target object(s) —
 *  used to resolve cross-object lookups into "@refId" placeholders after a per-object pull
 *  (each object is pulled with its own isolated `sf data export tree` call, so that command's
 *  own built-in cross-file reference linking never has visibility across objects — see
 *  resolvePulledLookupRefs). */
async function getReferenceFields(
    sobject: string,
    org: string,
    workspaceRoot: string,
): Promise<{ field: string; referenceTo: string[] }[]> {
    try {
        const { stdout } = await execSf(
            ["sobject", "describe", "--sobject", sobject, "--target-org", org, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        const fields: any[] = parsed?.result?.fields ?? [];
        return fields
            .filter(f => f.type === "reference" && Array.isArray(f.referenceTo) && f.referenceTo.length > 0)
            .map(f => ({ field: f.name as string, referenceTo: f.referenceTo as string[] }));
    } catch {
        return [];
    }
}

/** Build a map of {Salesforce record Id -> our referenceId} for every record already pulled for
 *  one sobject, from its seed file. Used to resolve OTHER objects' lookup fields that point to
 *  this object's records. */
export function buildIdToRefMap(seedDir: string, sobject: string): Map<string, string> {
    const map = new Map<string, string>();
    for (const record of readSeedRecords(seedDir, sobject)) {
        const id = record.Id as string | undefined;
        const refId = record.attributes?.referenceId as string | undefined;
        if (id && refId) { map.set(id, refId); }
    }
    return map;
}

/** Rewrites one object's seed file in place, replacing any lookup field value that's a raw
 *  Salesforce Id of an already-pulled parent record with "@<parentRefId>" — the same placeholder
 *  syntax `sf data export tree` itself uses, which loadData's substituteRefs() already resolves
 *  against the target org's newly-created/matched Ids at load time. A field is left untouched
 *  (and reported) when it points to an object we have no id map for yet — either that parent
 *  hasn't been pulled yet, or it's genuinely outside this migration (e.g. a lookup to User). */
export function resolveObjectLookupRefs(
    seedDir: string,
    sobject: string,
    referenceFields: { field: string; referenceTo: string[] }[],
    idMapsBySobject: Map<string, Map<string, string>>,
): { resolved: number; unresolved: number } {
    if (referenceFields.length === 0) { return { resolved: 0, unresolved: 0 }; }
    const candidates = [
        path.join(seedDir, `${sobject}s.json`),
        path.join(seedDir, `${sobject}.json`),
    ];
    let filePath = candidates.find(fp => fs.existsSync(fp));
    // Fallback: scan all .json files for one whose records have attributes.type matching sobject.
    // Handles sf data export tree files with timestamps, relationship suffixes, etc.
    if (!filePath) {
        try {
            for (const entry of fs.readdirSync(seedDir)) {
                if (!entry.endsWith(".json") || entry === "plan.json") { continue; }
                const fp = path.join(seedDir, entry);
                try {
                    const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
                    const recs: any[] = raw?.records ?? (Array.isArray(raw) ? raw : []);
                    if (recs.length > 0 && recs[0]?.attributes?.type?.toLowerCase() === sobject.toLowerCase()) {
                        filePath = fp;
                        break;
                    }
                } catch { /* skip unparseable files */ }
            }
        } catch { /* seedDir unreadable */ }
    }
    if (!filePath) { return { resolved: 0, unresolved: 0 }; }

    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const records: Record<string, any>[] = raw?.records ?? raw;
    let resolved = 0, unresolved = 0;

    for (const record of records) {
        for (const { field, referenceTo } of referenceFields) {
            const value = record[field];
            if (typeof value !== "string" || value === "" || value.startsWith("@")) { continue; }
            let ref: string | undefined;
            for (const parentType of referenceTo) {
                ref = idMapsBySobject.get(parentType)?.get(value);
                if (ref) { break; }
            }
            if (ref) {
                record[field] = `@${ref}`;
                resolved++;
            } else if (referenceTo.some(t => idMapsBySobject.has(t))) {
                // A parent we DID pull, but this specific Id wasn't among its records —
                // genuinely unresolved (parent record excluded by its own SOQL filter, etc.).
                unresolved++;
            }
            // else: parentType isn't one of our migrated objects at all (e.g. a lookup to
            // User/Owner) — leave the raw Id as-is, that's correct for an in-org reference.
        }
    }

    if (resolved > 0 || unresolved > 0) {
        raw.records = records;
        fs.writeFileSync(filePath, JSON.stringify(raw, null, 2), "utf-8");
    }
    return { resolved, unresolved };
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
// createExternalIdField
// ---------------------------------------------------------------------------

export async function createExternalIdField(
    targetOrg: string,
    sobject: string,
    workspaceRoot: string,
    onLog: LogFn,
): Promise<string> {
    const tmpDir = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-metadata", safeOrgName(sobject));
    const fieldsDir = path.join(tmpDir, "force-app", "main", "default", "objects", sobject, "fields");
    fs.mkdirSync(fieldsDir, { recursive: true });

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
  <fullName>External_Id__c</fullName>
  <label>External Id</label>
  <type>Text</type>
  <length>255</length>
  <externalId>true</externalId>
  <unique>true</unique>
</CustomField>
`;
    fs.writeFileSync(path.join(fieldsDir, "External_Id__c.field-meta.xml"), xml, "utf-8");

    onLog(`Deploying External_Id__c field to ${sobject}...`, "info");

    const sourceDir = path.join(tmpDir, "force-app");
    const deployResult = await execSf(
        ["project", "deploy", "start", "--source-dir", sourceDir,
         "--target-org", targetOrg, "--json", "--async"],
        { cwd: workspaceRoot, timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
    );

    const deployJson = JSON.parse(deployResult.stdout);
    const jobId: string = deployJson?.result?.id ?? deployJson?.result?.jobId;
    if (!jobId) { throw new Error(`Deploy did not return a job ID for ${sobject}`); }

    onLog(`Deploy job started: ${jobId}`, "info");

    // Poll until done — 100 × 3000ms ≈ 5 minutes maximum
    const maxPolls = 100;
    for (let poll = 0; poll < maxPolls; poll++) {
        await sleep(3000);
        const { stdout: reportOut } = await execSf(
            ["project", "deploy", "report", "--job-id", jobId, "--target-org", targetOrg, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 5 * 1024 * 1024 },
        );
        const report = JSON.parse(reportOut);
        const status: string = report?.result?.status ?? "";
        onLog(`Deploy status: ${status}`, "info");
        if (status === "Succeeded") { break; }
        if (status === "Failed" || status === "Canceled" || status === "Cancelled") {
            const errors = (report?.result?.details?.componentFailures ?? [])
                .map((f: any) => f.problem).join("; ");
            throw new Error(`Deploy failed for ${sobject} External_Id__c: ${errors || status}`);
        }
        if (poll === maxPolls - 1) {
            throw new Error(`ExternalId field deploy timed out after 5 minutes`);
        }
    }

    // Clean up temp metadata dir
    fs.rmSync(tmpDir, { recursive: true, force: true });

    onLog(`✓ External_Id__c created on ${sobject}`, "success");
    return "External_Id__c";
}

// ---------------------------------------------------------------------------
// Namespace detection helper
// ---------------------------------------------------------------------------

async function detectNamespace(
    targetOrg: string,
    workspaceRoot: string,
    firstCustomObj: string,
): Promise<string> {
    try {
        const { stdout } = await execSf(
            ["data", "query", "--query", `SELECT Id FROM ${firstCustomObj} LIMIT 1`,
             "--target-org", targetOrg, "--json"],
            { cwd: workspaceRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        // If query succeeded with no error the namespace prefix isn't blocking us
        void parsed;
        return "";
    } catch {
        return "";
    }
}

// ---------------------------------------------------------------------------
// Load data helpers
// ---------------------------------------------------------------------------

/** Replace @RefId tokens in lookup field values with real SF IDs from globalRefIndex */
function substituteRefs(
    record: Record<string, any>,
    globalRefIndex: Map<string, string>,
): { record: Record<string, any>; missingRefs: string[] } {
    const result: Record<string, any> = {};
    const missingRefs: string[] = [];

    for (const [key, value] of Object.entries(record)) {
        if (key === "attributes") { result[key] = value; continue; }
        if (typeof value === "string" && value.startsWith("@")) {
            const refKey = value.slice(1);
            const resolved = globalRefIndex.get(refKey);
            if (resolved) {
                result[key] = resolved;
            } else {
                missingRefs.push(refKey);
                result[key] = value;
            }
        } else {
            result[key] = value;
        }
    }

    return { record: result, missingRefs };
}

/** Apply namespace prefix to custom API names in field keys */
function applyNamespace(record: Record<string, any>, ns: string): Record<string, any> {
    if (!ns) { return record; }
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(record)) {
        if ((key.endsWith("__c") || key.endsWith("__r")) && (key.match(/__/g) || []).length === 1) {
            result[`${ns}__${key}`] = value;
        } else {
            result[key] = value;
        }
    }
    return result;
}

/** Build a CSV string from records, including the externalIdField column */
function buildCsv(
    records: Record<string, any>[],
    externalIdField: string,
): string {
    if (records.length === 0) { return ""; }
    const allKeys = new Set<string>();
    for (const r of records) {
        for (const k of Object.keys(r)) {
            if (k !== "attributes") { allKeys.add(k); }
        }
    }
    // Ensure external id field appears
    if (externalIdField) { allKeys.add(externalIdField); }
    const headers = Array.from(allKeys);
    const escape = (v: any): string => {
        if (v === null || v === undefined) { return ""; }
        const s = String(v);
        if (s.includes(",") || s.includes('"') || s.includes("\n")) {
            return `"${s.replace(/"/g, '""')}"`;
        }
        return s;
    };
    const rows = records.map(r => headers.map(h => escape(r[h])).join(","));
    return [headers.join(","), ...rows].join("\n");
}

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

/** After a Bulk API 2.0 upsert job completes with failures, the CLI only reports a generic
 *  "N records failed" message — the real per-record reasons require a separate `sf data bulk
 *  results` call that writes a `<jobId>-failed-records.csv` with an `sf__Error` column. This
 *  fetches that file and maps each failed row back to its referenceId via the externalId
 *  field value we stamped on every outbound record (see loadBatch's upsert path). Returns null
 *  if the results can't be fetched or parsed — callers fall back to the generic message. */
async function fetchBulkJobFailures(
    jobId: string,
    targetOrg: string,
    tmpDir: string,
    extField: string,
): Promise<{ refId: string; error: string }[] | null> {
    try {
        const { stdout } = await execSf(
            ["data", "bulk", "results", "--job-id", jobId, "--target-org", targetOrg, "--json"],
            { cwd: tmpDir, timeout: 60_000, maxBuffer: 20 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        const failedFilePath: string | undefined = parsed?.result?.failedFilePath;
        if (!failedFilePath) { return null; }
        const csvPath = path.isAbsolute(failedFilePath) ? failedFilePath : path.join(tmpDir, failedFilePath);
        if (!fs.existsSync(csvPath)) { return null; }
        const rows = parseCsv(fs.readFileSync(csvPath, "utf-8"));
        const out = rows.map(r => ({
            refId: r[extField] ?? "",
            error: r["sf__Error"] || "Unknown error (see failed-records CSV)",
        }));
        // Best-effort cleanup — these CSVs land in tmpDir and aren't needed once parsed.
        for (const suffix of ["-success-records.csv", "-failed-records.csv", "-unprocessed-records.csv"]) {
            try { fs.unlinkSync(path.join(tmpDir, `${jobId}${suffix}`)); } catch { /* ignore */ }
        }
        return out;
    } catch {
        return null;
    }
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
            }
        }

        for (const suffix of ["-success-records.csv", "-failed-records.csv", "-unprocessed-records.csv"]) {
            try { fs.unlinkSync(path.join(tmpDir, `${jobId}${suffix}`)); } catch { /* ignore */ }
        }

        return { successes, failures };
    } catch {
        return null;
    }
}

/** Read seed records for a given sobject from seedDir. Returns [] if no file found. */
function readSeedRecords(seedDir: string, sobject: string): Record<string, any>[] {
    // sf data export tree produces <SObjects>.json (plural) or uses plan.json listing
    const candidates = [
        path.join(seedDir, `${sobject}s.json`),
        path.join(seedDir, `${sobject}.json`),
    ];
    for (const fp of candidates) {
        if (fs.existsSync(fp)) {
            const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
            return (raw?.records ?? raw) as Record<string, any>[];
        }
    }
    // Check plan.json for file list — may be our own manifest (object) or sf CLI plan (array)
    const planPath = path.join(seedDir, "plan.json");
    if (fs.existsSync(planPath)) {
        const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
        // sf data export tree --plan produces [{sobject, saveRefs, resolveRefs, files:[]}]
        const planArray: any[] = Array.isArray(plan) ? plan : [];
        const entry = planArray.find((e: any) =>
            e.sobject?.toLowerCase() === sobject.toLowerCase());
        if (entry?.files?.length) {
            const records: Record<string, any>[] = [];
            for (const f of entry.files as string[]) {
                const fp2 = path.join(seedDir, f);
                if (fs.existsSync(fp2)) {
                    const raw = JSON.parse(fs.readFileSync(fp2, "utf-8"));
                    records.push(...(raw?.records ?? raw));
                }
            }
            return records;
        }
    }
    return [];
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
    jobId?: string; // Bulk API 2.0 job id — set only on the "N records failed" top-level error,
                     // so the caller can fetch the real per-record reasons via `sf data bulk results`.
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
            const jobId = typeof parsed?.data?.jobId === "string" ? parsed.data.jobId : undefined;
            return { created, createdByRef, failed, resultItems, limitException, jobId };
        }

        const rawResults: unknown = parsed?.result?.results ?? parsed?.result ?? [];

        if (typeof rawResults === "string" && rawResults.includes("LimitException")) {
            limitException = true;
            return { created, createdByRef, failed, resultItems, limitException };
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

// ---------------------------------------------------------------------------
// loadData (main function)
// ---------------------------------------------------------------------------

export async function loadData(
    targetOrg: string,
    workspaceRoot: string,
    config: DmConfig,
    onLog: LogFn,
    onProgress: ProgFn,
    controller: DmRunController,
    options?: DmRunOptions,
): Promise<{ loaded: number; failed: number; skipped: number; blocked: number }> {
    const ctrl = asInternal(controller);
    const startMs = Date.now();
    const seedDir = resolvedSeedDir(workspaceRoot, config, options);
    const dryRun = options?.dryRun ?? false;
    const logLines: string[] = [];
    const emit = (text: string, level: "info" | "success" | "warn" | "error" = "info") => {
        onLog(text, level);
        logLines.push(`[${level}] ${now()} ${text}`);
    };

    // ------------------------------------------------------------------
    // Pre-flight: ExternalId check — run all describes in parallel (batches
    // of 5) so we don't wait 2s × N objects before the load even starts.
    // ------------------------------------------------------------------
    if (!dryRun) {
        const allObjs = activeObjects(config);
        emit(`Pre-flight: checking ExternalId fields on ${allObjs.length} object(s)…`, "info");
        const chunks = chunkArray(allObjs, 5);
        for (const chunk of chunks) {
            const results = await Promise.allSettled(
                chunk.map(obj => checkExternalId(targetOrg, obj.sobject, workspaceRoot, () => {}))
            );
            for (let i = 0; i < chunk.length; i++) {
                const obj = chunk[i];
                const r = results[i];
                const found = r.status === "fulfilled" ? r.value : null;
                obj.externalIdField  = found ?? undefined;
                obj.externalIdVerified = !!found;
            }
        }
        writeDmConfig(workspaceRoot, config);
        const withExtId    = allObjs.filter(o => o.externalIdField);
        const withoutExtId = allObjs.filter(o => !o.externalIdField);
        if (withExtId.length)    { emit(`✓ Upsert mode: ${withExtId.map(o => o.sobject).join(", ")}`, "success"); }
        if (withoutExtId.length) { emit(`⚠  Insert mode (no ExternalId field): ${withoutExtId.map(o => o.sobject).join(", ")}`, "warn"); }
    }

    // ------------------------------------------------------------------
    // Prepare
    // ------------------------------------------------------------------
    let tracking = readTracking(workspaceRoot, targetOrg);

    // Detect namespace from first custom object (non-blocking)
    const allActive = activeObjects(config);
    const firstCustom = allActive.find(o => o.sobject.includes("__c"));
    const ns = firstCustom ? await detectNamespace(targetOrg, workspaceRoot, firstCustom.sobject) : "";

    // Build global ref index from already-tracked created records
    const globalRefIndex = new Map<string, string>();
    for (const [, objTracking] of Object.entries(tracking)) {
        for (const [refId, entry] of Object.entries(objTracking)) {
            if (entry.status === "created" && entry.id) {
                globalRefIndex.set(refId, entry.id);
            }
        }
    }

    // Resolve object list, cascading prerequisite dependencies when filter active
    let objectsToProcess = allActive;
    if (options?.objectFilter && options.objectFilter.length > 0) {
        const filterSet = new Set(options.objectFilter);
        const needed = new Set<string>();
        const addWithDeps = (sobject: string) => {
            if (needed.has(sobject)) { return; }
            needed.add(sobject);
            const obj = allActive.find(o => o.sobject === sobject);
            if (obj?.dependsOn) {
                for (const dep of obj.dependsOn) { addWithDeps(dep); }
            }
        };
        for (const f of options.objectFilter) { addWithDeps(f); }
        // Skip deps that are already fully complete
        objectsToProcess = allActive.filter(o => {
            if (!needed.has(o.sobject)) { return false; }
            if (!filterSet.has(o.sobject)) {
                // It's a dependency — only include if not fully created
                const objT = tracking[o.sobject] ?? {};
                const hasUncreated = Object.values(objT).some(e => e.status !== "created");
                return hasUncreated || Object.keys(objT).length === 0;
            }
            return true;
        });
    }

    // ------------------------------------------------------------------
    // Object statuses for progress events
    // ------------------------------------------------------------------
    const objStatusMap = new Map<string, { status: "done" | "running" | "pending" | "skipped"; created: number; updated: number; alreadyDone: number; total: number; failed: number; skipped: number }>();
    for (const o of objectsToProcess) {
        objStatusMap.set(o.sobject, { status: "pending", created: 0, updated: 0, alreadyDone: 0, total: 0, failed: 0, skipped: 0 });
    }

    let totalLoaded = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalBlocked = 0;

    const tmpDir = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-load");
    fs.mkdirSync(tmpDir, { recursive: true });

    // Computed once and cached — avoids synchronous disk reads on every batch progress emit.
    let cachedGrandTotal: number | null = null;

    const buildProgressEvent = (
        obj: DmObjectConfig,
        objIdx: number,
        batchIdx: number,
        batchCount: number,
        batchDone: number,
        batchTotal: number,
    ): DmProgressEvent => {
        const elapsedMs = Date.now() - startMs;
        const recordsDone = totalLoaded + totalFailed + totalSkipped + totalBlocked + batchDone;
        if (cachedGrandTotal === null) {
            cachedGrandTotal = objectsToProcess.reduce((sum, o) => {
                const recs = readSeedRecords(seedDir, o.sobject);
                return sum + recs.length;
            }, 0);
        }
        const grandTotal = cachedGrandTotal;
        const remaining = Math.max(0, grandTotal - recordsDone);
        const estimatedRemainingMs = recordsDone > 0
            ? Math.round((elapsedMs / recordsDone) * remaining)
            : 0;
        return {
            phase: "load",
            currentObject: obj.sobject,
            objectIndex: objIdx + 1,
            objectCount: objectsToProcess.length,
            batchIndex: batchIdx + 1,
            batchCount,
            recordsDone,
            recordsTotal: grandTotal,
            recordsCreated: totalLoaded,
            recordsFailed: totalFailed,
            recordsSkipped: totalSkipped,
            objectStatuses: objectsToProcess.map(o => {
                const s = objStatusMap.get(o.sobject) ?? { status: "pending", created: 0, total: 0 };
                return { sobject: o.sobject, ...s };
            }),
            elapsedMs,
            estimatedRemainingMs,
        };
    };

    // ------------------------------------------------------------------
    // Main object loop
    // ------------------------------------------------------------------
    for (let objIdx = 0; objIdx < objectsToProcess.length; objIdx++) {
        if (ctrl.state === "cancelled") { break; }

        const obj = objectsToProcess[objIdx];
        objStatusMap.set(obj.sobject, {
            ...objStatusMap.get(obj.sobject)!,
            status: "running",
        });

        emit(`Loading ${obj.sobject} (${objIdx + 1}/${objectsToProcess.length})...`, "info");

        const allRecords = readSeedRecords(seedDir, obj.sobject);
        if (allRecords.length === 0) {
            emit(`No seed records found for ${obj.sobject} — skipping`, "warn");
            objStatusMap.set(obj.sobject, { status: "skipped", created: 0, updated: 0, alreadyDone: 0, total: 0, failed: 0, skipped: 0 });
            continue;
        }

        objStatusMap.get(obj.sobject)!.total = allRecords.length;

        // Initialise tracking for this object if not present
        if (!tracking[obj.sobject]) { tracking[obj.sobject] = {}; }

        // sf data import tree is limited to 200 records per call; upsert bulk can handle more
        const effectiveBatchSize = obj.externalIdField ? config.batchSize : Math.min(config.batchSize, 200);
        const batches = chunkArray(allRecords, effectiveBatchSize);
        let objectSkipped = false;
        const insertedThisObject: { refId: string; sfId: string }[] = [];

        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            // ---- Controller checkpoint ----
            if (stateOf(ctrl) === "cancelled") { writeTracking(workspaceRoot, targetOrg, tracking); return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked }; }
            if (stateOf(ctrl) === "paused") { await waitForResume(controller, onLog); }
            if (stateOf(ctrl) === "cancelled") { writeTracking(workspaceRoot, targetOrg, tracking); return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked }; }
            if (ctrl._consumeSkip()) {
                // Mark remaining pending records as skipped
                for (const rec of batches.slice(batchIdx).flat()) {
                    const refId = (rec.attributes?.referenceId as string | undefined) ?? `${obj.sobject}Ref${allRecords.indexOf(rec)}`;
                    if (tracking[obj.sobject][refId]?.status !== "created") {
                        tracking[obj.sobject][refId] = { status: "skipped", at: now() };
                        totalSkipped++;
                    }
                }
                objectSkipped = true;
                break;
            }

            const batch = batches[batchIdx];
            const processable: { refId: string; record: Record<string, any> }[] = [];

            for (let recIdx = 0; recIdx < batch.length; recIdx++) {
                const raw = batch[recIdx];
                const globalRecIdx = batchIdx * effectiveBatchSize + recIdx;
                const refId = (raw.attributes?.referenceId as string | undefined) ?? `${obj.sobject}Ref${globalRecIdx}`;

                // Skip already-created records
                if (tracking[obj.sobject][refId]?.status === "created") {
                    objStatusMap.get(obj.sobject)!.alreadyDone++;
                    continue;
                }

                const { record: subbed, missingRefs } = substituteRefs(raw, globalRefIndex);
                if (missingRefs.length > 0) {
                    emit(`Blocking ${refId}: unresolved refs [${missingRefs.join(", ")}]`, "warn");
                    tracking[obj.sobject][refId] = { status: "blocked", error: `Unresolved refs: ${missingRefs.join(", ")}`, at: now() };
                    totalBlocked++;
                    continue;
                }

                const nsRecord = applyNamespace(subbed, ns);
                processable.push({ refId, record: nsRecord });
            }

            if (processable.length === 0) {
                onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, 0, batch.length));
                continue;
            }

            if (dryRun) {
                emit(`[dry-run] Would load ${processable.length} record(s) for ${obj.sobject} batch ${batchIdx + 1}`, "info");
                for (const { refId } of processable) {
                    tracking[obj.sobject][refId] = { status: "skipped", at: now() };
                    totalSkipped++;
                }
                onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, processable.length, batch.length));
                continue;
            }

            // ---- Perform the actual load (with governor-limit retry) ----
            await loadBatch(
                obj, processable, targetOrg, workspaceRoot, tmpDir,
                tracking, globalRefIndex,
                emit,
                (created, updated, failed) => {
                    totalLoaded += created + updated;
                    totalFailed += failed;
                    const s = objStatusMap.get(obj.sobject)!;
                    s.created += created;
                    s.updated += updated;
                    s.failed  += failed;
                    if (failed === 0) {
                        const parts: string[] = [];
                        if (created > 0) { parts.push(`${created} pushed ✓`); }
                        if (updated > 0) { parts.push(`${updated} updated ✓`); }
                        if (parts.length > 0) { emit(`  ${obj.sobject} batch ${batchIdx + 1}: ${parts.join(", ")}`, "success"); }
                    }
                },
                effectiveBatchSize,
                !obj.externalIdField ? insertedThisObject : undefined,
            );

            writeTracking(workspaceRoot, targetOrg, tracking);
            onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, processable.length, batch.length));
        }

        writeTracking(workspaceRoot, targetOrg, tracking);

        // After insert-mode: backfill ExternalId field so re-runs use upsert
        if (!obj.externalIdField && insertedThisObject.length > 0 && !dryRun) {
            await backfillExternalIds(obj, insertedThisObject, targetOrg, workspaceRoot, tmpDir, emit, config);
            if (obj.externalIdField) { writeDmConfig(workspaceRoot, config); }
        }

        const finalStatus = objectSkipped ? "skipped" : "done";
        objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject)!, status: finalStatus });
        emit(`✓ ${obj.sobject}: ${summarizeObjectResult(objStatusMap.get(obj.sobject)!)}`, "success");
    }

    // ------------------------------------------------------------------
    // Dry-run report
    // ------------------------------------------------------------------
    if (dryRun) {
        const reportPath = path.join(workspaceRoot, ".git", "sf-devops-dm", "dryrun", "report.json");
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify({
            generatedAt: now(),
            targetOrg,
            totalLoaded,
            totalFailed,
            totalSkipped,
            totalBlocked,
        }, null, 2), "utf-8");
    }

    // ── End-of-load summary ──────────────────────────────────────────────────
    const summaryParts = [`${totalLoaded} pushed`];
    if (totalFailed > 0)  { summaryParts.push(`${totalFailed} failed`); }
    if (totalSkipped > 0) { summaryParts.push(`${totalSkipped} skipped`); }
    if (totalBlocked > 0) { summaryParts.push(`${totalBlocked} blocked`); }
    emit(`─── Load complete: ${summaryParts.join(" · ")} ───`, totalFailed > 0 ? "warn" : "success");

    writeLastRunLog(workspaceRoot, logLines);
    appendHistoryEntry(workspaceRoot, {
        at: now(),
        op: "load",
        targetOrg,
        dryRun,
        loaded: totalLoaded,
        failed: totalFailed,
        skipped: totalSkipped,
        blocked: totalBlocked,
    });

    ctrl._setState("done");
    return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked };
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// backfillExternalIds — after insert mode, stamp ExternalId field values so
// the next load run can switch to idempotent upsert instead of re-inserting.
// ---------------------------------------------------------------------------

async function backfillExternalIds(
    obj: DmObjectConfig,
    insertedRecords: { refId: string; sfId: string }[],
    targetOrg: string,
    workspaceRoot: string,
    tmpDir: string,
    emit: LogFn,
    config: DmConfig,
): Promise<void> {
    if (insertedRecords.length === 0) { return; }

    // Re-check for ExternalId field — may have been created after the pre-flight
    const extField = await checkExternalId(targetOrg, obj.sobject, workspaceRoot, () => {});
    if (!extField) {
        emit(`ℹ  ${obj.sobject}: no ExternalId field found — records inserted without ExternalId. Add External_Id__c in Salesforce to enable idempotent re-runs.`, "info");
        return;
    }

    emit(`Stamping ExternalId (${extField}) on ${insertedRecords.length} ${obj.sobject} record(s)…`, "info");

    // Build CSV: Id + ExternalId field. Upsert-by-Id is a bulk update.
    const header = `Id,${extField}`;
    const rows   = insertedRecords.map(r => `${csvEscape(r.sfId)},${csvEscape(r.refId)}`);
    const csvPath = path.join(tmpDir, `${safeOrgName(obj.sobject)}-backfill-${Date.now()}.csv`);
    fs.writeFileSync(csvPath, [header, ...rows].join("\n"), "utf-8");

    try {
        await execSf(
            ["data", "upsert", "bulk",
             "--sobject", obj.sobject,
             "--external-id", "Id",
             "--file", csvPath,
             "--target-org", targetOrg,
             "--wait", "10",
             "--json"],
            { cwd: workspaceRoot, timeout: 120_000, maxBuffer: 10 * 1024 * 1024 },
        );
        emit(`✓ ExternalId stamped on ${insertedRecords.length} ${obj.sobject} record(s) — next load will use upsert mode`, "success");
        // Update config so the next run picks up the field immediately
        obj.externalIdField  = extField;
        obj.externalIdVerified = true;
    } catch (e: any) {
        emit(`⚠  Could not stamp ExternalId on ${obj.sobject}: ${e?.message ?? String(e)}`, "warn");
    } finally {
        try { fs.unlinkSync(csvPath); } catch { /* ignore */ }
    }
}

// loadBatch — recursive halving on LimitException
// ---------------------------------------------------------------------------

async function loadBatch(
    obj: DmObjectConfig,
    processable: { refId: string; record: Record<string, any> }[],
    targetOrg: string,
    workspaceRoot: string,
    tmpDir: string,
    tracking: TrackingFile,
    globalRefIndex: Map<string, string>,
    emit: LogFn,
    onCount: (created: number, updated: number, failed: number) => void,
    maxBatchSize: number,
    insertedRecords?: { refId: string; sfId: string }[],
): Promise<void> {
    let stdout = "";
    let attemptFailed = false;

    let loadFilePath: string | undefined;
    try {
        if (obj.externalIdField) {
            // Upsert via bulk CSV.
            // Inject the referenceId as the ExternalId field value when the record doesn't
            // already have one. This makes upserts idempotent: re-runs match existing records
            // by the same stable key rather than creating duplicates with blank ExternalId.
            const extField = obj.externalIdField;
            const records = processable.map(p => ({
                ...p.record,
                [extField]: p.record[extField] ?? p.refId,
            }));
            const csv = buildCsv(records, extField);
            const csvPath = path.join(tmpDir, `${safeOrgName(obj.sobject)}-${Date.now()}.csv`);
            loadFilePath = csvPath;
            fs.writeFileSync(csvPath, csv, "utf-8");

            const result = await execSf(
                ["data", "upsert", "bulk",
                 "--sobject", obj.sobject,
                 "--external-id", obj.externalIdField,
                 "--file", csvPath,
                 "--target-org", targetOrg,
                 "--wait", "10",
                 "--json"],
                { cwd: workspaceRoot, timeout: 180_000, maxBuffer: 50 * 1024 * 1024 },
            );
            stdout = result.stdout;
        } else {
            // Import tree JSON
            const treePayload = {
                records: processable.map(p => ({
                    ...p.record,
                    attributes: { type: obj.sobject, referenceId: p.refId },
                })),
            };
            const jsonPath = path.join(tmpDir, `${safeOrgName(obj.sobject)}-${Date.now()}.json`);
            loadFilePath = jsonPath;
            fs.writeFileSync(jsonPath, JSON.stringify(treePayload, null, 2), "utf-8");

            const result = await execSf(
                ["data", "import", "tree",
                 "--files", jsonPath,
                 "--target-org", targetOrg,
                 "--json"],
                { cwd: workspaceRoot, timeout: 180_000, maxBuffer: 50 * 1024 * 1024 },
            );
            stdout = result.stdout;
        }
    } catch (e: any) {
        stdout = e?.stdout ?? "";
        attemptFailed = true;
    } finally {
        if (loadFilePath && fs.existsSync(loadFilePath)) {
            try { fs.unlinkSync(loadFilePath); } catch { /* ignore */ }
        }
    }

    const parsedResult = parseImportResult(stdout);
    const { created, createdByRef, resultItems, limitException, jobId } = parsedResult;
    let failed = parsedResult.failed;

    // Bulk API 2.0 exits non-zero even when SOME records succeed — fetch both success and
    // failure CSVs so we can correctly mark successes without re-inserting them on retry,
    // and surface per-record errors instead of the opaque "N records failed" summary.
    if (jobId && obj.externalIdField) {
        const extField = obj.externalIdField;
        const allResults = await fetchBulkJobAllResults(jobId, targetOrg, tmpDir, extField);
        if (allResults) {
            // Build lookup maps keyed by the ExternalId field value that was in the CSV.
            // The CSV column always contains record[extField] ?? refId (see CSV construction above),
            // so matching on that value correctly handles both native and synthetic ExternalIds.
            const successByExtId = new Map(allResults.successes.map(s => [s.extIdVal, s]));
            const failureByExtId = new Map(allResults.failures.map(f => [f.extIdVal, f]));

            // Rebuild resultItems positionally so the main mapping loop works correctly.
            resultItems.length = 0;
            for (const p of processable) {
                const extIdVal = String(p.record[extField] ?? p.refId);
                const success = successByExtId.get(extIdVal);
                const failure = failureByExtId.get(extIdVal);
                if (success) {
                    resultItems.push({ sfId: success.sfId, success: true, error: "", wasNewRecord: success.wasNewRecord });
                } else {
                    resultItems.push({ sfId: "", success: false, error: failure?.error ?? "Unknown error", wasNewRecord: false });
                }
            }

            // If we successfully reconstructed full results, clear the attemptFailed flag so
            // the main mapping loop uses resultItems instead of the fallback "all failed" path.
            if (resultItems.length === processable.length) {
                attemptFailed = false;
            }

            // Update failed list with correct per-record errors keyed by extIdVal.
            failed = allResults.failures.map(f => ({ refId: f.extIdVal, error: f.error }));
        }
    }

    // Governor-limit retry: split batch in half (down to single record)
    if (limitException && processable.length > 1) {
        emit(`Governor limit hit for ${obj.sobject} batch of ${processable.length} — splitting`, "warn");
        const half = Math.ceil(processable.length / 2);
        await loadBatch(obj, processable.slice(0, half), targetOrg, workspaceRoot, tmpDir, tracking, globalRefIndex, emit, onCount, maxBatchSize, insertedRecords);
        await loadBatch(obj, processable.slice(half), targetOrg, workspaceRoot, tmpDir, tracking, globalRefIndex, emit, onCount, maxBatchSize, insertedRecords);
        return;
    }

    // Map results back to tracking entries.
    // Strategy:
    //   Import tree  → createdByRef keyed by referenceId (always populated)
    //   Upsert bulk  → resultItems[i] positionally aligned to processable[i]
    //                  (bulk results have no referenceId, so createdByRef is empty)
    if (resultItems.length > 0 || createdByRef.size > 0 || attemptFailed) {
        let batchCreated = 0;
        let batchUpdated = 0;
        let batchFailed = 0;
        for (let i = 0; i < processable.length; i++) {
            const { refId } = processable[i];
            // Import tree path: lookup by referenceId — always a genuine new record
            const sfIdByRef = createdByRef.get(refId);
            if (sfIdByRef) {
                tracking[obj.sobject][refId] = { status: "created", id: sfIdByRef, at: now() };
                globalRefIndex.set(refId, sfIdByRef);
                insertedRecords?.push({ refId, sfId: sfIdByRef });
                batchCreated++;
                continue;
            }
            // Upsert bulk path: positional result (full list includes successes AND failures).
            // "created" tracking status covers both — it means "exists correctly in the target
            // org", regardless of whether this run inserted it or matched+updated an existing one.
            const posResult = resultItems[i];
            if (posResult?.success) {
                tracking[obj.sobject][refId] = { status: "created", id: posResult.sfId, at: now() };
                globalRefIndex.set(refId, posResult.sfId);
                if (posResult.wasNewRecord) { batchCreated++; } else { batchUpdated++; }
            } else {
                const failedByRef = failed.find(f => f.refId === refId);
                const err = failedByRef?.error ?? posResult?.error ?? (attemptFailed ? "Batch failed" : "No result");
                tracking[obj.sobject][refId] = { status: "failed", error: err, at: now() };
                batchFailed++;
            }
        }
        onCount(batchCreated, batchUpdated, batchFailed);
        if (batchFailed > 0) {
            const parts = [];
            if (batchCreated > 0) { parts.push(`${batchCreated} created`); }
            if (batchUpdated > 0) { parts.push(`${batchUpdated} updated`); }
            if (parts.length === 0) { parts.push("0 created"); }
            emit(`${obj.sobject}: ${parts.join(", ")}, ${batchFailed} failed in batch`, "warn");
            const seenHints = new Set<string>();
            for (const f of failed) {
                const hint = parseFieldError(obj.sobject, f.error);
                if (hint && !seenHints.has(hint)) {
                    seenHints.add(hint);
                    emit(`  → ${hint}`, "warn");
                } else if (!hint && f.error && f.error !== "unknown") {
                    const shortErr = f.error.length > 200 ? f.error.slice(0, 200) + "…" : f.error;
                    if (!seenHints.has(shortErr)) {
                        seenHints.add(shortErr);
                        emit(`  ✗ ${obj.sobject}[${f.refId}]: ${shortErr}`, "error");
                    }
                }
            }
        }
    } else if (attemptFailed) {
        for (const { refId } of processable) {
            tracking[obj.sobject][refId] = { status: "failed", error: "No parseable result", at: now() };
        }
        onCount(0, 0, processable.length);
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
    // Pass B: data-proven dependency discovery from seed files
    // ------------------------------------------------------------------
    const seedDir = path.resolve(workspaceRoot, config.seedDir);
    const dataDeps = new Map<string, Set<string>>();
    for (const o of objects) { dataDeps.set(o.sobject, new Set()); }

    if (fs.existsSync(seedDir)) {
        for (const obj of objects) {
            const records = readSeedRecords(seedDir, obj.sobject);
            const deps = dataDeps.get(obj.sobject)!;
            for (const record of records) {
                for (const value of Object.values(record)) {
                    if (typeof value !== "string") { continue; }
                    // @RefId tokens like AccountRef1 → sobject = Account
                    if (value.startsWith("@")) {
                        const refToken = value.slice(1);
                        // Extract prefix before the first digit sequence
                        const match = refToken.match(/^([A-Za-z][A-Za-z0-9_]*?)(?:Ref)?\d+$/);
                        if (match) {
                            const candidate = match[1];
                            if (sobjectNames.has(candidate) && candidate !== obj.sobject) {
                                deps.add(candidate);
                            }
                        }
                    }
                }
            }
        }
    }

    // Pass B supersedes Pass A: merge, preferring data evidence
    const finalDeps = new Map<string, Set<string>>();
    for (const o of objects) {
        const data = dataDeps.get(o.sobject) ?? new Set<string>();
        const schema = schemaDeps.get(o.sobject) ?? new Set<string>();
        // If data has any entries, use data only; otherwise fall back to schema
        finalDeps.set(o.sobject, data.size > 0 ? data : schema);
    }

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
