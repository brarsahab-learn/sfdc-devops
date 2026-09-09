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

function chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
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

    for (let i = 0; i < objects.length; i++) {
        if (ctrl.state === "cancelled") { break; }

        const obj = objects[i];
        onLog(`Pulling ${obj.sobject} (${i + 1}/${objects.length})...`, "info");

        let query = obj.query?.trim() || `SELECT Id FROM ${obj.sobject}`;

        if (options?.dryRun && !/LIMIT\s+\d+/i.test(query)) {
            query += ` LIMIT ${options.dryRunSampleSize ?? 5}`;
        }

        const tmpDir = path.join(tmpRoot, `${safeOrgName(obj.sobject)}-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            const { stdout } = await execSf(
                ["data", "export", "tree", "--query", query, "--output-dir", tmpDir, "--plan",
                 "--target-org", sourceOrg, "--json"],
                { cwd: workspaceRoot, timeout: 300_000, maxBuffer: 100 * 1024 * 1024 },
            );

            const parsed = JSON.parse(stdout);
            if (parsed.status !== 0) {
                const rawMsg: string = parsed.message ?? "unknown error";
                const fieldHint = parseFieldError(obj.sobject, rawMsg);
                onLog(`Pull failed for ${obj.sobject}: ${rawMsg}`, "error");
                if (fieldHint) { onLog(`  → ${fieldHint}`, "warn"); }
                continue;
            }

            // Move all output files from tmpDir to seedDir (overwriting existing)
            const exported = fs.readdirSync(tmpDir);
            for (const file of exported) {
                const src = path.join(tmpDir, file);
                const dst = path.join(seedDir, file);
                fs.copyFileSync(src, dst);
                fs.unlinkSync(src);
            }
            fs.rmdirSync(tmpDir);

            pulledObjects.push(obj.sobject);
            onLog(`✓ Pulled ${obj.sobject}`, "success");
        } catch (e: any) {
            // Try to parse stdout from the thrown error (sf CLI exits non-zero on warnings too)
            const rawOut: string = e?.stdout ?? "";
            try {
                const parsed = JSON.parse(rawOut);
                const msg: string = parsed?.message ?? parsed?.result?.message ?? e.message ?? String(e);
                onLog(`Pull failed for ${obj.sobject}: ${msg}`, "error");
                const fieldHint = parseFieldError(obj.sobject, msg);
                if (fieldHint) { onLog(`  → ${fieldHint}`, "warn"); }
            } catch {
                const msg: string = e?.message ?? String(e);
                onLog(`Pull failed for ${obj.sobject}: ${msg}`, "error");
                const fieldHint = parseFieldError(obj.sobject, msg);
                if (fieldHint) { onLog(`  → ${fieldHint}`, "warn"); }
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
            { cwd: workspaceRoot, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout);
        const fields: any[] = parsed?.result?.fields ?? [];
        const found = fields.find(f => f.externalId === true || /External_?Id__c$/i.test(f.name));
        if (found) {
            onLog(`Found external ID field on ${sobject}: ${found.name}`, "success");
            return found.name as string;
        }
        onLog(`No external ID field found on ${sobject}`, "info");
        return null;
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

    // Poll until done
    for (;;) {
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
        if ((key.endsWith("__c") || key.endsWith("__r")) && !key.includes("__")) {
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
    // Check plan.json for file list
    const planPath = path.join(seedDir, "plan.json");
    if (fs.existsSync(planPath)) {
        const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
        // sf data export tree --plan produces [{sobject, saveRefs, resolveRefs, files:[]}]
        const entry = (plan as any[]).find((e: any) =>
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

/** Parse upsert/import result and extract created/failed counts + refId mapping */
function parseImportResult(
    stdout: string,
): { created: string[]; failed: { refId: string; error: string }[]; limitException: boolean } {
    const created: string[] = [];
    const failed: { refId: string; error: string }[] = [];
    let limitException = false;

    try {
        const parsed = JSON.parse(stdout);
        const rawResults: unknown = parsed?.result?.results ?? parsed?.result ?? [];

        if (typeof rawResults === "string" && rawResults.includes("LimitException")) {
            limitException = true;
            return { created, failed, limitException };
        }

        const items: any[] = Array.isArray(rawResults) ? rawResults : [];
        for (const item of items) {
            if (item.success === true || item.created === true || item.isCreated === true) {
                created.push(item.id ?? item.referenceId ?? "");
            } else {
                const err = (item.errors ?? []).map((e: any) => e.message ?? String(e)).join("; ");
                if (err.includes("LimitException")) { limitException = true; }
                failed.push({ refId: item.referenceId ?? "", error: err || "unknown" });
            }
        }
    } catch {
        if (stdout.includes("LimitException")) { limitException = true; }
    }

    return { created, failed, limitException };
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
    // Pre-flight: ensure external ID fields exist
    // ------------------------------------------------------------------
    if (config.autoCreateExternalId && !dryRun) {
        for (const obj of activeObjects(config)) {
            if (obj.externalIdVerified) { continue; }
            const found = await checkExternalId(targetOrg, obj.sobject, workspaceRoot, onLog);
            if (found) {
                obj.externalIdField = found;
                obj.externalIdVerified = true;
                writeDmConfig(workspaceRoot, config);
            } else {
                try {
                    const created = await createExternalIdField(targetOrg, obj.sobject, workspaceRoot, onLog);
                    obj.externalIdField = created;
                    obj.externalIdVerified = true;
                    writeDmConfig(workspaceRoot, config);
                } catch (e: any) {
                    emit(`ExternalId creation failed — aborting load: ${e?.message ?? String(e)}`, "error");
                    return { loaded: 0, failed: 0, skipped: 0, blocked: 0 };
                }
            }
        }
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
    const objStatusMap = new Map<string, { status: "done" | "running" | "pending" | "skipped"; created: number; total: number }>();
    for (const o of objectsToProcess) {
        objStatusMap.set(o.sobject, { status: "pending", created: 0, total: 0 });
    }

    let totalLoaded = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalBlocked = 0;

    const tmpDir = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-load");
    fs.mkdirSync(tmpDir, { recursive: true });

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
        const grandTotal = objectsToProcess.reduce((sum, o) => {
            const recs = readSeedRecords(seedDir, o.sobject);
            return sum + recs.length;
        }, 0);
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
            objStatusMap.set(obj.sobject, { status: "skipped", created: 0, total: 0 });
            continue;
        }

        objStatusMap.get(obj.sobject)!.total = allRecords.length;

        // Initialise tracking for this object if not present
        if (!tracking[obj.sobject]) { tracking[obj.sobject] = {}; }

        const batches = chunkArray(allRecords, config.batchSize);
        let objectSkipped = false;

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
                const globalRecIdx = batchIdx * config.batchSize + recIdx;
                const refId = (raw.attributes?.referenceId as string | undefined) ?? `${obj.sobject}Ref${globalRecIdx}`;

                // Skip already-created records
                if (tracking[obj.sobject][refId]?.status === "created") { continue; }

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
                (created, failed) => {
                    totalLoaded += created;
                    totalFailed += failed;
                    objStatusMap.get(obj.sobject)!.created += created;
                },
                config.batchSize,
            );

            writeTracking(workspaceRoot, targetOrg, tracking);
            onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, processable.length, batch.length));
        }

        writeTracking(workspaceRoot, targetOrg, tracking);

        const finalStatus = objectSkipped ? "skipped" : "done";
        objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject)!, status: finalStatus });
        emit(`✓ ${obj.sobject}: ${objStatusMap.get(obj.sobject)!.created} created`, "success");
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
    onCount: (created: number, failed: number) => void,
    maxBatchSize: number,
): Promise<void> {
    let stdout = "";
    let attemptFailed = false;

    try {
        if (obj.externalIdField) {
            // Upsert via bulk CSV
            const csv = buildCsv(processable.map(p => p.record), obj.externalIdField);
            const csvPath = path.join(tmpDir, `${safeOrgName(obj.sobject)}-${Date.now()}.csv`);
            fs.writeFileSync(csvPath, csv, "utf-8");

            const result = await execSf(
                ["data", "upsert", "bulk",
                 "--sobject", obj.sobject,
                 "--external-id-field", obj.externalIdField,
                 "--file", csvPath,
                 "--target-org", targetOrg,
                 "--wait", "10",
                 "--json"],
                { cwd: workspaceRoot, timeout: 180_000, maxBuffer: 50 * 1024 * 1024 },
            );
            stdout = result.stdout;
            fs.unlinkSync(csvPath);
        } else {
            // Import tree JSON
            const treePayload = {
                records: processable.map(p => ({
                    ...p.record,
                    attributes: { type: obj.sobject, referenceId: p.refId },
                })),
            };
            const jsonPath = path.join(tmpDir, `${safeOrgName(obj.sobject)}-${Date.now()}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(treePayload, null, 2), "utf-8");

            const result = await execSf(
                ["data", "import", "tree",
                 "--files", jsonPath,
                 "--target-org", targetOrg,
                 "--json"],
                { cwd: workspaceRoot, timeout: 180_000, maxBuffer: 50 * 1024 * 1024 },
            );
            stdout = result.stdout;
            fs.unlinkSync(jsonPath);
        }
    } catch (e: any) {
        stdout = e?.stdout ?? "";
        attemptFailed = true;
    }

    const { created, failed, limitException } = parseImportResult(stdout);

    // Governor-limit retry: split batch in half (down to single record)
    if (limitException && processable.length > 1) {
        emit(`Governor limit hit for ${obj.sobject} batch of ${processable.length} — splitting`, "warn");
        const half = Math.ceil(processable.length / 2);
        await loadBatch(obj, processable.slice(0, half), targetOrg, workspaceRoot, tmpDir, tracking, globalRefIndex, emit, onCount, maxBatchSize);
        await loadBatch(obj, processable.slice(half), targetOrg, workspaceRoot, tmpDir, tracking, globalRefIndex, emit, onCount, maxBatchSize);
        return;
    }

    // Map results back to tracking entries by position (sf returns results in order)
    if (created.length > 0 || failed.length > 0) {
        // created[] contains SF IDs in the same order as processable
        for (let i = 0; i < processable.length; i++) {
            const { refId } = processable[i];
            const sfId = created[i];
            if (sfId) {
                tracking[obj.sobject][refId] = { status: "created", id: sfId, at: now() };
                globalRefIndex.set(refId, sfId);
            } else {
                const failedEntry = failed.find(f => f.refId === refId) ?? failed[i];
                const err = failedEntry?.error ?? "unknown";
                tracking[obj.sobject][refId] = { status: "failed", error: err, at: now() };
            }
        }
        onCount(created.length, failed.length);
        if (failed.length > 0) {
            emit(`${obj.sobject}: ${created.length} created, ${failed.length} failed in batch`, "warn");
            // Emit field-specific hints for each distinct error pattern
            const seenHints = new Set<string>();
            for (const f of failed) {
                const hint = parseFieldError(obj.sobject, f.error);
                if (hint && !seenHints.has(hint)) {
                    seenHints.add(hint);
                    emit(`  → ${hint}`, "warn");
                } else if (!hint && f.error && f.error !== "unknown") {
                    // Surface raw error for non-field issues (e.g. validation rules, required fields)
                    const shortErr = f.error.length > 200 ? f.error.slice(0, 200) + "…" : f.error;
                    if (!seenHints.has(shortErr)) {
                        seenHints.add(shortErr);
                        emit(`  ✗ ${obj.sobject}[${f.refId}]: ${shortErr}`, "error");
                    }
                }
            }
        }
    } else if (attemptFailed) {
        // Couldn't parse results — mark all as failed
        for (const { refId } of processable) {
            tracking[obj.sobject][refId] = { status: "failed", error: "No parseable result", at: now() };
        }
        onCount(0, processable.length);
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
    for (const [, deps] of finalDeps) {
        for (const dep of deps) {
            // dep must come BEFORE the object that depends on it — dep has no extra in-degree here;
            // the object that references dep gets +1 for each of its dependencies.
        }
    }
    // Re-build: for each node, its in-degree = number of objects that must come before it
    // An object A depends on B means B → A, so A's in-degree increases
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

    writeDmConfig(workspaceRoot, config);
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
                    deleted++;
                } else {
                    const err = (r?.errors ?? []).map((e: any) => e.message).join("; ") || "unknown";
                    tracking[obj.sobject][refId] = { status: "delete-failed", error: err, at: now() };
                    deleteFailed++;
                }
            }
        } catch (e: any) {
            onLog(`Delete bulk failed for ${obj.sobject}: ${e?.message ?? String(e)}`, "error");
            for (const [refId,] of createdEntries) {
                tracking[obj.sobject][refId] = { status: "delete-failed", error: e?.message ?? "execSf error", at: now() };
                deleteFailed++;
            }
        }

        fs.unlinkSync(csvPath);
        writeTracking(workspaceRoot, targetOrg, tracking);
        onLog(`✓ ${obj.sobject}: ${deleted} deleted`, "success");
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
