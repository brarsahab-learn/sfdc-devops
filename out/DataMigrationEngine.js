"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeController = makeController;
exports.pullData = pullData;
exports.checkExternalId = checkExternalId;
exports.createExternalIdField = createExternalIdField;
exports.parseImportResult = parseImportResult;
exports.loadData = loadData;
exports.autoSortByDependencies = autoSortByDependencies;
exports.rollbackData = rollbackData;
exports.listAvailableOrgs = listAvailableOrgs;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const SfCli_1 = require("./SfCli");
const DataMigrationConfig_1 = require("./DataMigrationConfig");
// ---------------------------------------------------------------------------
// makeController
// ---------------------------------------------------------------------------
function makeController() {
    let _state = "running";
    let _skip = false;
    const ctrl = {
        pause() { if (_state === "running") {
            _state = "paused";
        } },
        resume() { if (_state === "paused") {
            _state = "running";
        } },
        cancel() { _state = "cancelled"; },
        skipObject() { _skip = true; },
        get state() { return _state; },
        get _skip() { return _skip; },
        set _skip(v) { _skip = v; },
        _consumeSkip() { const v = _skip; _skip = false; return v; },
        _setState(s) { _state = s; },
    };
    return ctrl;
}
function asInternal(ctrl) {
    return ctrl;
}
/** Read controller state through a function call so TS cannot narrow it across loop iterations. */
function stateOf(ctrl) {
    return ctrl.state;
}
function activeObjects(config) {
    return config.objects.filter(o => o.active).sort((a, b) => a.order - b.order);
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
async function waitForResume(ctrl, onLog) {
    onLog("⏸ Paused — waiting for resume...", "info");
    while (ctrl.state === "paused") {
        await sleep(500);
    }
}
function resolvedSeedDir(workspaceRoot, config, options) {
    if (options?.dryRun) {
        return path.join(workspaceRoot, ".git", "sf-devops-dm", "dryrun", "seed");
    }
    return path.resolve(workspaceRoot, config.seedDir);
}
function now() {
    return new Date().toISOString();
}
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}
/** Extract the offending field name from a Salesforce error string. */
function extractBadFieldName(msg) {
    const patterns = [
        /No such column '([^']+)'/i,
        /INVALID_FIELD[^:]*:[^[]*\[([^\]]+)\]/i,
        /Unknown field:\s*([^\s,\n]+)/i,
        /field not readable:\s*([^\s,]+)/i,
    ];
    for (const re of patterns) {
        const m = msg.match(re);
        if (m) {
            return m[1].trim();
        }
    }
    return null;
}
/** Remove a field from a SOQL SELECT clause. Returns null if nothing is left to select. */
function stripFieldFromQuery(query, field) {
    const m = query.match(/^(SELECT\s+)([\s\S]+?)(\s+FROM\b[\s\S]*)$/i);
    if (!m) {
        return null;
    }
    const fields = m[2].split(",").map(f => f.trim()).filter(f => f.toLowerCase() !== field.toLowerCase() && f !== "");
    if (fields.length === 0) {
        return null;
    }
    return `${m[1]}${fields.join(", ")}${m[3]}`;
}
/** Count records in data JSON files exported by sf data export tree for a given sobject. */
function countExportedRecords(dir) {
    let count = 0;
    try {
        for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith(".json") || f.endsWith("-plan.json")) {
                continue;
            }
            const data = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
            count += Array.isArray(data.records) ? data.records.length : 0;
        }
    }
    catch { /* ignore */ }
    return count;
}
/**
 * Parse a Salesforce CLI error message and return a user-friendly field-level explanation.
 * Returns null if the error is not field-related.
 */
function parseFieldError(sobject, raw) {
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
async function pullData(sourceOrg, workspaceRoot, config, onLog, onProgress, controller, options) {
    const ctrl = asInternal(controller);
    const objects = activeObjects(config);
    const seedDir = resolvedSeedDir(workspaceRoot, config, options);
    const tmpRoot = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-pull");
    (0, DataMigrationConfig_1.ensureDmDirs)(workspaceRoot, config.seedDir);
    fs.mkdirSync(seedDir, { recursive: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    const startMs = Date.now();
    const pulledObjects = [];
    for (let i = 0; i < objects.length; i++) {
        if (ctrl.state === "cancelled") {
            break;
        }
        const obj = objects[i];
        onLog(`Pulling ${obj.sobject} (${i + 1}/${objects.length})...`, "info");
        let query = obj.query?.trim() || `SELECT Id FROM ${obj.sobject}`;
        if (options?.dryRun && !/LIMIT\s+\d+/i.test(query)) {
            query += ` LIMIT ${options.dryRunSampleSize ?? 5}`;
        }
        const tmpDir = path.join(tmpRoot, `${(0, DataMigrationConfig_1.safeOrgName)(obj.sobject)}-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        // Auto-heal loop: retry after stripping unrecognised fields from SELECT
        for (let attempt = 0; attempt <= 20; attempt++) {
            let rawMsg = "";
            try {
                const { stdout } = await (0, SfCli_1.execSf)(["data", "export", "tree", "--query", query, "--output-dir", tmpDir, "--plan",
                    "--target-org", sourceOrg, "--json"], { cwd: workspaceRoot, timeout: 300000, maxBuffer: 100 * 1024 * 1024 });
                const parsed = JSON.parse(stdout);
                if (parsed.status !== 0) {
                    rawMsg = String(parsed.message ?? "unknown error");
                }
                else {
                    // Count records from exported files before moving
                    const recordCount = countExportedRecords(tmpDir);
                    // Move all output files from tmpDir to seedDir (overwriting existing)
                    for (const file of fs.readdirSync(tmpDir)) {
                        fs.copyFileSync(path.join(tmpDir, file), path.join(seedDir, file));
                        fs.unlinkSync(path.join(tmpDir, file));
                    }
                    try {
                        fs.rmdirSync(tmpDir);
                    }
                    catch { /* ignore */ }
                    pulledObjects.push(obj.sobject);
                    onLog(`✓ Pulled ${obj.sobject}: ${recordCount} record${recordCount !== 1 ? "s" : ""}`, "success");
                    break; // success
                }
            }
            catch (e) {
                const rawOut = e?.stdout ?? "";
                try {
                    const p = JSON.parse(rawOut);
                    rawMsg = String(p?.message ?? p?.result?.message ?? e.message ?? String(e));
                }
                catch {
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
                        try {
                            for (const f of fs.readdirSync(tmpDir)) {
                                fs.unlinkSync(path.join(tmpDir, f));
                            }
                        }
                        catch { /* ignore */ }
                        continue;
                    }
                }
                onLog(`Pull failed for ${obj.sobject}: ${rawMsg}`, "error");
                const fieldHint = parseFieldError(obj.sobject, rawMsg);
                if (fieldHint) {
                    onLog(`  → ${fieldHint}`, "warn");
                }
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
async function checkExternalId(targetOrg, sobject, workspaceRoot, onLog) {
    onLog(`Checking external ID field on ${sobject}...`, "info");
    try {
        const { stdout } = await (0, SfCli_1.execSf)(["sobject", "describe", "--sobject", sobject, "--target-org", targetOrg, "--json"], { cwd: workspaceRoot, timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
        const parsed = JSON.parse(stdout);
        const fields = parsed?.result?.fields ?? [];
        // Only fields explicitly flagged externalId: true can be used as SF upsert keys.
        // Among those, prefer one matching our naming conventions (any namespace prefix,
        // including multi-segment like ns1__ns2__External_Id__c, and both single/double
        // underscore separators: ExternalId__c, External_Id__c, External__Id__c).
        const extIdFields = fields.filter(f => f.externalId === true);
        if (extIdFields.length === 0) {
            onLog(`ℹ  No ExternalId field found on ${sobject}`, "info");
            return null;
        }
        const preferred = extIdFields.find(f => /^(?:\w+__)*External_?_?Id__c$/i.test(f.name)) ?? extIdFields[0];
        onLog(`✓ ExternalId field on ${sobject}: ${preferred.name}`, "success");
        return preferred.name;
    }
    catch (e) {
        onLog(`Describe failed for ${sobject}: ${e?.message ?? String(e)}`, "warn");
        return null;
    }
}
// ---------------------------------------------------------------------------
// createExternalIdField
// ---------------------------------------------------------------------------
async function createExternalIdField(targetOrg, sobject, workspaceRoot, onLog) {
    const tmpDir = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-metadata", (0, DataMigrationConfig_1.safeOrgName)(sobject));
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
    const deployResult = await (0, SfCli_1.execSf)(["project", "deploy", "start", "--source-dir", sourceDir,
        "--target-org", targetOrg, "--json", "--async"], { cwd: workspaceRoot, timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
    const deployJson = JSON.parse(deployResult.stdout);
    const jobId = deployJson?.result?.id ?? deployJson?.result?.jobId;
    if (!jobId) {
        throw new Error(`Deploy did not return a job ID for ${sobject}`);
    }
    onLog(`Deploy job started: ${jobId}`, "info");
    // Poll until done
    for (;;) {
        await sleep(3000);
        const { stdout: reportOut } = await (0, SfCli_1.execSf)(["project", "deploy", "report", "--job-id", jobId, "--target-org", targetOrg, "--json"], { cwd: workspaceRoot, timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
        const report = JSON.parse(reportOut);
        const status = report?.result?.status ?? "";
        onLog(`Deploy status: ${status}`, "info");
        if (status === "Succeeded") {
            break;
        }
        if (status === "Failed" || status === "Canceled" || status === "Cancelled") {
            const errors = (report?.result?.details?.componentFailures ?? [])
                .map((f) => f.problem).join("; ");
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
async function detectNamespace(targetOrg, workspaceRoot, firstCustomObj) {
    try {
        const { stdout } = await (0, SfCli_1.execSf)(["data", "query", "--query", `SELECT Id FROM ${firstCustomObj} LIMIT 1`,
            "--target-org", targetOrg, "--json"], { cwd: workspaceRoot, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
        const parsed = JSON.parse(stdout);
        // If query succeeded with no error the namespace prefix isn't blocking us
        void parsed;
        return "";
    }
    catch {
        return "";
    }
}
// ---------------------------------------------------------------------------
// Load data helpers
// ---------------------------------------------------------------------------
/** Replace @RefId tokens in lookup field values with real SF IDs from globalRefIndex */
function substituteRefs(record, globalRefIndex) {
    const result = {};
    const missingRefs = [];
    for (const [key, value] of Object.entries(record)) {
        if (key === "attributes") {
            result[key] = value;
            continue;
        }
        if (typeof value === "string" && value.startsWith("@")) {
            const refKey = value.slice(1);
            const resolved = globalRefIndex.get(refKey);
            if (resolved) {
                result[key] = resolved;
            }
            else {
                missingRefs.push(refKey);
                result[key] = value;
            }
        }
        else {
            result[key] = value;
        }
    }
    return { record: result, missingRefs };
}
/** Apply namespace prefix to custom API names in field keys */
function applyNamespace(record, ns) {
    if (!ns) {
        return record;
    }
    const result = {};
    for (const [key, value] of Object.entries(record)) {
        if ((key.endsWith("__c") || key.endsWith("__r")) && !key.includes("__")) {
            result[`${ns}__${key}`] = value;
        }
        else {
            result[key] = value;
        }
    }
    return result;
}
/** Build a CSV string from records, including the externalIdField column */
function buildCsv(records, externalIdField) {
    if (records.length === 0) {
        return "";
    }
    const allKeys = new Set();
    for (const r of records) {
        for (const k of Object.keys(r)) {
            if (k !== "attributes") {
                allKeys.add(k);
            }
        }
    }
    // Ensure external id field appears
    if (externalIdField) {
        allKeys.add(externalIdField);
    }
    const headers = Array.from(allKeys);
    const escape = (v) => {
        if (v === null || v === undefined) {
            return "";
        }
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
function readSeedRecords(seedDir, sobject) {
    // sf data export tree produces <SObjects>.json (plural) or uses plan.json listing
    const candidates = [
        path.join(seedDir, `${sobject}s.json`),
        path.join(seedDir, `${sobject}.json`),
    ];
    for (const fp of candidates) {
        if (fs.existsSync(fp)) {
            const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
            return (raw?.records ?? raw);
        }
    }
    // Check plan.json for file list — may be our own manifest (object) or sf CLI plan (array)
    const planPath = path.join(seedDir, "plan.json");
    if (fs.existsSync(planPath)) {
        const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
        // sf data export tree --plan produces [{sobject, saveRefs, resolveRefs, files:[]}]
        const planArray = Array.isArray(plan) ? plan : [];
        const entry = planArray.find((e) => e.sobject?.toLowerCase() === sobject.toLowerCase());
        if (entry?.files?.length) {
            const records = [];
            for (const f of entry.files) {
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
function parseImportResult(stdout) {
    const created = [];
    const createdByRef = new Map();
    const failed = [];
    const resultItems = [];
    let limitException = false;
    try {
        const parsed = JSON.parse(stdout);
        // Top-level CLI error (e.g. bad flag, auth failure) has no `result` key at all — surface
        // its message instead of silently reporting "0 created, N failed" with no detail.
        if (parsed?.result === undefined && typeof parsed?.message === "string") {
            const errStr = parsed.message;
            if (errStr.includes("LimitException")) {
                limitException = true;
            }
            failed.push({ refId: "", error: errStr });
            return { created, createdByRef, failed, resultItems, limitException };
        }
        const rawResults = parsed?.result?.results ?? parsed?.result ?? [];
        if (typeof rawResults === "string" && rawResults.includes("LimitException")) {
            limitException = true;
            return { created, createdByRef, failed, resultItems, limitException };
        }
        const items = Array.isArray(rawResults) ? rawResults : [];
        for (const item of items) {
            const hasErrors = Array.isArray(item.errors) && item.errors.length > 0;
            const isSuccess = item.success === true ||
                item.created === true ||
                item.isCreated === true ||
                // sf data import tree shape: has an id but no explicit success flag
                (typeof item.id === "string" && item.id.length >= 15 && !hasErrors);
            if (isSuccess) {
                const sfId = item.id ?? "";
                const refId = (item.referenceId ?? item.refId ?? "");
                created.push(sfId);
                if (refId) {
                    createdByRef.set(refId, sfId);
                }
                resultItems.push({ sfId, success: true, error: "" });
            }
            else {
                const errText = hasErrors
                    ? item.errors.map((e) => e.message ?? String(e)).join("; ")
                    : (item.message ?? item.error ?? "unknown");
                const errStr = String(errText) || "unknown";
                if (errStr.includes("LimitException")) {
                    limitException = true;
                }
                const refId = (item.referenceId ?? item.refId ?? "");
                failed.push({ refId, error: errStr });
                resultItems.push({ sfId: "", success: false, error: errStr });
            }
        }
    }
    catch {
        if (stdout.includes("LimitException")) {
            limitException = true;
        }
    }
    return { created, createdByRef, failed, resultItems, limitException };
}
// ---------------------------------------------------------------------------
// loadData (main function)
// ---------------------------------------------------------------------------
async function loadData(targetOrg, workspaceRoot, config, onLog, onProgress, controller, options) {
    const ctrl = asInternal(controller);
    const startMs = Date.now();
    const seedDir = resolvedSeedDir(workspaceRoot, config, options);
    const dryRun = options?.dryRun ?? false;
    const logLines = [];
    const emit = (text, level = "info") => {
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
            const results = await Promise.allSettled(chunk.map(obj => checkExternalId(targetOrg, obj.sobject, workspaceRoot, () => { })));
            for (let i = 0; i < chunk.length; i++) {
                const obj = chunk[i];
                const r = results[i];
                const found = r.status === "fulfilled" ? r.value : null;
                obj.externalIdField = found ?? undefined;
                obj.externalIdVerified = !!found;
            }
        }
        (0, DataMigrationConfig_1.writeDmConfig)(workspaceRoot, config);
        const withExtId = allObjs.filter(o => o.externalIdField);
        const withoutExtId = allObjs.filter(o => !o.externalIdField);
        if (withExtId.length) {
            emit(`✓ Upsert mode: ${withExtId.map(o => o.sobject).join(", ")}`, "success");
        }
        if (withoutExtId.length) {
            emit(`⚠  Insert mode (no ExternalId field): ${withoutExtId.map(o => o.sobject).join(", ")}`, "warn");
        }
    }
    // ------------------------------------------------------------------
    // Prepare
    // ------------------------------------------------------------------
    let tracking = (0, DataMigrationConfig_1.readTracking)(workspaceRoot, targetOrg);
    // Detect namespace from first custom object (non-blocking)
    const allActive = activeObjects(config);
    const firstCustom = allActive.find(o => o.sobject.includes("__c"));
    const ns = firstCustom ? await detectNamespace(targetOrg, workspaceRoot, firstCustom.sobject) : "";
    // Build global ref index from already-tracked created records
    const globalRefIndex = new Map();
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
        const needed = new Set();
        const addWithDeps = (sobject) => {
            if (needed.has(sobject)) {
                return;
            }
            needed.add(sobject);
            const obj = allActive.find(o => o.sobject === sobject);
            if (obj?.dependsOn) {
                for (const dep of obj.dependsOn) {
                    addWithDeps(dep);
                }
            }
        };
        for (const f of options.objectFilter) {
            addWithDeps(f);
        }
        // Skip deps that are already fully complete
        objectsToProcess = allActive.filter(o => {
            if (!needed.has(o.sobject)) {
                return false;
            }
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
    const objStatusMap = new Map();
    for (const o of objectsToProcess) {
        objStatusMap.set(o.sobject, { status: "pending", created: 0, total: 0 });
    }
    let totalLoaded = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalBlocked = 0;
    const tmpDir = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-load");
    fs.mkdirSync(tmpDir, { recursive: true });
    const buildProgressEvent = (obj, objIdx, batchIdx, batchCount, batchDone, batchTotal) => {
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
        if (ctrl.state === "cancelled") {
            break;
        }
        const obj = objectsToProcess[objIdx];
        objStatusMap.set(obj.sobject, {
            ...objStatusMap.get(obj.sobject),
            status: "running",
        });
        emit(`Loading ${obj.sobject} (${objIdx + 1}/${objectsToProcess.length})...`, "info");
        const allRecords = readSeedRecords(seedDir, obj.sobject);
        if (allRecords.length === 0) {
            emit(`No seed records found for ${obj.sobject} — skipping`, "warn");
            objStatusMap.set(obj.sobject, { status: "skipped", created: 0, total: 0 });
            continue;
        }
        objStatusMap.get(obj.sobject).total = allRecords.length;
        // Initialise tracking for this object if not present
        if (!tracking[obj.sobject]) {
            tracking[obj.sobject] = {};
        }
        // sf data import tree is limited to 200 records per call; upsert bulk can handle more
        const effectiveBatchSize = obj.externalIdField ? config.batchSize : Math.min(config.batchSize, 200);
        const batches = chunkArray(allRecords, effectiveBatchSize);
        let objectSkipped = false;
        const insertedThisObject = [];
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            // ---- Controller checkpoint ----
            if (stateOf(ctrl) === "cancelled") {
                (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
                return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked };
            }
            if (stateOf(ctrl) === "paused") {
                await waitForResume(controller, onLog);
            }
            if (stateOf(ctrl) === "cancelled") {
                (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
                return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked };
            }
            if (ctrl._consumeSkip()) {
                // Mark remaining pending records as skipped
                for (const rec of batches.slice(batchIdx).flat()) {
                    const refId = rec.attributes?.referenceId ?? `${obj.sobject}Ref${allRecords.indexOf(rec)}`;
                    if (tracking[obj.sobject][refId]?.status !== "created") {
                        tracking[obj.sobject][refId] = { status: "skipped", at: now() };
                        totalSkipped++;
                    }
                }
                objectSkipped = true;
                break;
            }
            const batch = batches[batchIdx];
            const processable = [];
            for (let recIdx = 0; recIdx < batch.length; recIdx++) {
                const raw = batch[recIdx];
                const globalRecIdx = batchIdx * config.batchSize + recIdx;
                const refId = raw.attributes?.referenceId ?? `${obj.sobject}Ref${globalRecIdx}`;
                // Skip already-created records
                if (tracking[obj.sobject][refId]?.status === "created") {
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
            await loadBatch(obj, processable, targetOrg, workspaceRoot, tmpDir, tracking, globalRefIndex, emit, (created, failed) => {
                totalLoaded += created;
                totalFailed += failed;
                objStatusMap.get(obj.sobject).created += created;
            }, effectiveBatchSize, !obj.externalIdField ? insertedThisObject : undefined);
            (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
            onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, processable.length, batch.length));
        }
        (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
        // After insert-mode: backfill ExternalId field so re-runs use upsert
        if (!obj.externalIdField && insertedThisObject.length > 0 && !dryRun) {
            await backfillExternalIds(obj, insertedThisObject, targetOrg, workspaceRoot, tmpDir, emit, config);
            if (obj.externalIdField) {
                (0, DataMigrationConfig_1.writeDmConfig)(workspaceRoot, config);
            }
        }
        const finalStatus = objectSkipped ? "skipped" : "done";
        objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject), status: finalStatus });
        emit(`✓ ${obj.sobject}: ${objStatusMap.get(obj.sobject).created} created`, "success");
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
    (0, DataMigrationConfig_1.writeLastRunLog)(workspaceRoot, logLines);
    (0, DataMigrationConfig_1.appendHistoryEntry)(workspaceRoot, {
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
async function backfillExternalIds(obj, insertedRecords, targetOrg, workspaceRoot, tmpDir, emit, config) {
    if (insertedRecords.length === 0) {
        return;
    }
    // Re-check for ExternalId field — may have been created after the pre-flight
    const extField = await checkExternalId(targetOrg, obj.sobject, workspaceRoot, () => { });
    if (!extField) {
        emit(`ℹ  ${obj.sobject}: no ExternalId field found — records inserted without ExternalId. Add External_Id__c in Salesforce to enable idempotent re-runs.`, "info");
        return;
    }
    emit(`Stamping ExternalId (${extField}) on ${insertedRecords.length} ${obj.sobject} record(s)…`, "info");
    // Build CSV: Id + ExternalId field. Upsert-by-Id is a bulk update.
    const header = `Id,${extField}`;
    const rows = insertedRecords.map(r => `${r.sfId},${r.refId}`);
    const csvPath = path.join(tmpDir, `${(0, DataMigrationConfig_1.safeOrgName)(obj.sobject)}-backfill-${Date.now()}.csv`);
    fs.writeFileSync(csvPath, [header, ...rows].join("\n"), "utf-8");
    try {
        await (0, SfCli_1.execSf)(["data", "upsert", "bulk",
            "--sobject", obj.sobject,
            "--external-id", "Id",
            "--file", csvPath,
            "--target-org", targetOrg,
            "--wait", "10",
            "--json"], { cwd: workspaceRoot, timeout: 120000, maxBuffer: 10 * 1024 * 1024 });
        emit(`✓ ExternalId stamped on ${insertedRecords.length} ${obj.sobject} record(s) — next load will use upsert mode`, "success");
        // Update config so the next run picks up the field immediately
        obj.externalIdField = extField;
        obj.externalIdVerified = true;
    }
    catch (e) {
        emit(`⚠  Could not stamp ExternalId on ${obj.sobject}: ${e?.message ?? String(e)}`, "warn");
    }
    finally {
        try {
            fs.unlinkSync(csvPath);
        }
        catch { /* ignore */ }
    }
}
// loadBatch — recursive halving on LimitException
// ---------------------------------------------------------------------------
async function loadBatch(obj, processable, targetOrg, workspaceRoot, tmpDir, tracking, globalRefIndex, emit, onCount, maxBatchSize, insertedRecords) {
    let stdout = "";
    let attemptFailed = false;
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
            const csvPath = path.join(tmpDir, `${(0, DataMigrationConfig_1.safeOrgName)(obj.sobject)}-${Date.now()}.csv`);
            fs.writeFileSync(csvPath, csv, "utf-8");
            const result = await (0, SfCli_1.execSf)(["data", "upsert", "bulk",
                "--sobject", obj.sobject,
                "--external-id", obj.externalIdField,
                "--file", csvPath,
                "--target-org", targetOrg,
                "--wait", "10",
                "--json"], { cwd: workspaceRoot, timeout: 180000, maxBuffer: 50 * 1024 * 1024 });
            stdout = result.stdout;
            fs.unlinkSync(csvPath);
        }
        else {
            // Import tree JSON
            const treePayload = {
                records: processable.map(p => ({
                    ...p.record,
                    attributes: { type: obj.sobject, referenceId: p.refId },
                })),
            };
            const jsonPath = path.join(tmpDir, `${(0, DataMigrationConfig_1.safeOrgName)(obj.sobject)}-${Date.now()}.json`);
            fs.writeFileSync(jsonPath, JSON.stringify(treePayload, null, 2), "utf-8");
            const result = await (0, SfCli_1.execSf)(["data", "import", "tree",
                "--files", jsonPath,
                "--target-org", targetOrg,
                "--json"], { cwd: workspaceRoot, timeout: 180000, maxBuffer: 50 * 1024 * 1024 });
            stdout = result.stdout;
            fs.unlinkSync(jsonPath);
        }
    }
    catch (e) {
        stdout = e?.stdout ?? "";
        attemptFailed = true;
    }
    const { created, createdByRef, failed, resultItems, limitException } = parseImportResult(stdout);
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
        let batchFailed = 0;
        for (let i = 0; i < processable.length; i++) {
            const { refId } = processable[i];
            // Import tree path: lookup by referenceId
            const sfIdByRef = createdByRef.get(refId);
            if (sfIdByRef) {
                tracking[obj.sobject][refId] = { status: "created", id: sfIdByRef, at: now() };
                globalRefIndex.set(refId, sfIdByRef);
                insertedRecords?.push({ refId, sfId: sfIdByRef });
                batchCreated++;
                continue;
            }
            // Upsert bulk path: positional result (full list includes successes AND failures)
            const posResult = resultItems[i];
            if (posResult?.success) {
                tracking[obj.sobject][refId] = { status: "created", id: posResult.sfId, at: now() };
                globalRefIndex.set(refId, posResult.sfId);
                batchCreated++;
            }
            else {
                const failedByRef = failed.find(f => f.refId === refId);
                const err = failedByRef?.error ?? posResult?.error ?? (attemptFailed ? "Batch failed" : "No result");
                tracking[obj.sobject][refId] = { status: "failed", error: err, at: now() };
                batchFailed++;
            }
        }
        onCount(batchCreated, batchFailed);
        if (batchFailed > 0) {
            emit(`${obj.sobject}: ${batchCreated} created, ${batchFailed} failed in batch`, "warn");
            const seenHints = new Set();
            for (const f of failed) {
                const hint = parseFieldError(obj.sobject, f.error);
                if (hint && !seenHints.has(hint)) {
                    seenHints.add(hint);
                    emit(`  → ${hint}`, "warn");
                }
                else if (!hint && f.error && f.error !== "unknown") {
                    const shortErr = f.error.length > 200 ? f.error.slice(0, 200) + "…" : f.error;
                    if (!seenHints.has(shortErr)) {
                        seenHints.add(shortErr);
                        emit(`  ✗ ${obj.sobject}[${f.refId}]: ${shortErr}`, "error");
                    }
                }
            }
        }
    }
    else if (attemptFailed) {
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
async function autoSortByDependencies(targetOrg, workspaceRoot, config, onLog) {
    const objects = activeObjects(config);
    const sobjectNames = new Set(objects.map(o => o.sobject));
    // ------------------------------------------------------------------
    // Pass A: schema-based dependency discovery (5-concurrent)
    // ------------------------------------------------------------------
    const schemaDeps = new Map();
    for (const o of objects) {
        schemaDeps.set(o.sobject, new Set());
    }
    const describeChunks = chunkArray(objects, 5);
    for (const chunk of describeChunks) {
        const results = await Promise.allSettled(chunk.map(async (obj) => {
            try {
                const { stdout } = await (0, SfCli_1.execSf)(["sobject", "describe", "--sobject", obj.sobject, "--target-org", targetOrg, "--json"], { cwd: workspaceRoot, timeout: 60000, maxBuffer: 10 * 1024 * 1024 });
                const parsed = JSON.parse(stdout);
                const fields = parsed?.result?.fields ?? [];
                const deps = new Set();
                for (const f of fields) {
                    if (f.type === "reference" && Array.isArray(f.referenceTo)) {
                        for (const ref of f.referenceTo) {
                            if (sobjectNames.has(ref) && ref !== obj.sobject) {
                                deps.add(ref);
                            }
                        }
                    }
                }
                return { sobject: obj.sobject, deps };
            }
            catch {
                return { sobject: obj.sobject, deps: new Set() };
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
    const dataDeps = new Map();
    for (const o of objects) {
        dataDeps.set(o.sobject, new Set());
    }
    if (fs.existsSync(seedDir)) {
        for (const obj of objects) {
            const records = readSeedRecords(seedDir, obj.sobject);
            const deps = dataDeps.get(obj.sobject);
            for (const record of records) {
                for (const value of Object.values(record)) {
                    if (typeof value !== "string") {
                        continue;
                    }
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
    const finalDeps = new Map();
    for (const o of objects) {
        const data = dataDeps.get(o.sobject) ?? new Set();
        const schema = schemaDeps.get(o.sobject) ?? new Set();
        // If data has any entries, use data only; otherwise fall back to schema
        finalDeps.set(o.sobject, data.size > 0 ? data : schema);
    }
    // ------------------------------------------------------------------
    // Topological sort — Kahn's algorithm
    // ------------------------------------------------------------------
    const inDegree = new Map();
    for (const o of objects) {
        inDegree.set(o.sobject, 0);
    }
    for (const [, deps] of finalDeps) {
        for (const dep of deps) {
            // dep must come BEFORE the object that depends on it — dep has no extra in-degree here;
            // the object that references dep gets +1 for each of its dependencies.
        }
    }
    // Re-build: for each node, its in-degree = number of objects that must come before it
    // An object A depends on B means B → A, so A's in-degree increases
    for (const o of objects) {
        for (const dep of finalDeps.get(o.sobject)) {
            inDegree.set(o.sobject, (inDegree.get(o.sobject) ?? 0) + 1);
        }
    }
    const queue = [];
    for (const o of objects) {
        if ((inDegree.get(o.sobject) ?? 0) === 0) {
            queue.push(o.sobject);
        }
    }
    const sorted = [];
    const processed = new Set();
    while (queue.length > 0) {
        const node = queue.shift();
        sorted.push(node);
        processed.add(node);
        // Find all nodes that depend on `node` and decrement their in-degree
        for (const o of objects) {
            if (finalDeps.get(o.sobject)?.has(node)) {
                const newDeg = (inDegree.get(o.sobject) ?? 0) - 1;
                inDegree.set(o.sobject, newDeg);
                if (newDeg === 0) {
                    queue.push(o.sobject);
                }
            }
        }
    }
    // Nodes not processed = cycles — log and append in original order
    const cycleNodes = objects.filter(o => !processed.has(o.sobject));
    if (cycleNodes.length > 0) {
        onLog(`Warning: dependency cycles detected for [${cycleNodes.map(o => o.sobject).join(", ")}] — keeping original order`, "warn");
        for (const o of cycleNodes) {
            sorted.push(o.sobject);
        }
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
    (0, DataMigrationConfig_1.writeDmConfig)(workspaceRoot, config);
    onLog("✓ Dependency sort complete", "success");
    return config;
}
// ---------------------------------------------------------------------------
// rollbackData
// ---------------------------------------------------------------------------
async function rollbackData(targetOrg, workspaceRoot, config, onLog, options) {
    const tracking = (0, DataMigrationConfig_1.readTracking)(workspaceRoot, targetOrg);
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
        if (createdEntries.length === 0) {
            continue;
        }
        onLog(`Rolling back ${obj.sobject}: ${createdEntries.length} record(s)`, "info");
        if (dryRun) {
            onLog(`[dry-run] Would delete ${createdEntries.length} ${obj.sobject} records`, "info");
            continue;
        }
        // Write CSV of IDs
        const csvLines = ["Id", ...createdEntries.map(([, e]) => e.id)];
        const csvPath = path.join(tmpDir, `${(0, DataMigrationConfig_1.safeOrgName)(obj.sobject)}-rollback-${Date.now()}.csv`);
        fs.writeFileSync(csvPath, csvLines.join("\n"), "utf-8");
        try {
            const { stdout } = await (0, SfCli_1.execSf)(["data", "delete", "bulk",
                "--sobject", obj.sobject,
                "--file", csvPath,
                "--target-org", targetOrg,
                "--wait", "10",
                "--json"], { cwd: workspaceRoot, timeout: 180000, maxBuffer: 20 * 1024 * 1024 });
            const parsed = JSON.parse(stdout);
            const results = parsed?.result?.results ?? [];
            for (const [idx, [refId,]] of createdEntries.entries()) {
                const r = results[idx];
                if (r?.success === true || r?.deleted === true) {
                    tracking[obj.sobject][refId] = { status: "deleted", at: now() };
                    deleted++;
                }
                else {
                    const err = (r?.errors ?? []).map((e) => e.message).join("; ") || "unknown";
                    tracking[obj.sobject][refId] = { status: "delete-failed", error: err, at: now() };
                    deleteFailed++;
                }
            }
        }
        catch (e) {
            onLog(`Delete bulk failed for ${obj.sobject}: ${e?.message ?? String(e)}`, "error");
            for (const [refId,] of createdEntries) {
                tracking[obj.sobject][refId] = { status: "delete-failed", error: e?.message ?? "execSf error", at: now() };
                deleteFailed++;
            }
        }
        fs.unlinkSync(csvPath);
        (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
        onLog(`✓ ${obj.sobject}: ${deleted} deleted`, "success");
    }
    // Clean up tmp dir if empty
    try {
        fs.rmdirSync(tmpDir);
    }
    catch { /* not empty or already gone */ }
    (0, DataMigrationConfig_1.appendHistoryEntry)(workspaceRoot, {
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
async function listAvailableOrgs(workspaceRoot) {
    try {
        const { stdout } = await (0, SfCli_1.execSf)(["org", "list", "--json"], { cwd: workspaceRoot, timeout: 30000, maxBuffer: 5 * 1024 * 1024 });
        const parsed = JSON.parse(stdout);
        const nonScratch = parsed?.result?.nonScratchOrgs ?? [];
        const scratch = parsed?.result?.scratchOrgs ?? [];
        return [...nonScratch, ...scratch].map(org => ({
            alias: org.alias ?? org.username ?? "",
            username: org.username ?? "",
            isDevHub: org.isDevHub === true,
            connectedStatus: org.connectedStatus ?? org.status ?? "Unknown",
        }));
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=DataMigrationEngine.js.map