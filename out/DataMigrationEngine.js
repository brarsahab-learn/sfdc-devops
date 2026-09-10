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
exports.summarizeObjectResult = summarizeObjectResult;
exports.pullData = pullData;
exports.checkExternalId = checkExternalId;
exports.parseCsv = parseCsv;
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
function csvEscape(val) {
    if (val.includes(",") || val.includes('"') || val.includes("\n")) {
        return `"${val.replace(/"/g, '""')}"`;
    }
    return val;
}
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}
/** Renders a per-object load summary that distinguishes genuine new records from upsert updates
 *  and from records that needed no work at all — plain "0 created" reads as a failure even when
 *  every record already existed correctly in the target org (e.g. a re-run after a prior success,
 *  or an idempotent upsert that only matched existing records). */
function summarizeObjectResult(status) {
    const { created, updated, alreadyDone, total, failed = 0, skipped = 0 } = status;
    const parts = [];
    if (created > 0) {
        parts.push(`${created} created`);
    }
    if (updated > 0) {
        parts.push(`${updated} updated`);
    }
    if (alreadyDone > 0) {
        parts.push(`${alreadyDone} already up to date`);
    }
    if (failed > 0) {
        parts.push(`${failed} failed ✗`);
    }
    if (skipped > 0) {
        parts.push(`${skipped} skipped`);
    }
    if (parts.length === 0) {
        return total > 0 ? "0 processed" : "0 records";
    }
    return parts.join(", ");
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
async function getReferenceFields(sobject, org, workspaceRoot) {
    try {
        const { stdout } = await (0, SfCli_1.execSf)(["sobject", "describe", "--sobject", sobject, "--target-org", org, "--json"], { cwd: workspaceRoot, timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
        const parsed = JSON.parse(stdout);
        const fields = parsed?.result?.fields ?? [];
        return fields
            .filter(f => f.type === "reference" && Array.isArray(f.referenceTo) && f.referenceTo.length > 0)
            .map(f => ({
            field: f.name,
            referenceTo: f.referenceTo,
            relationshipName: (f.relationshipName ?? f.name.replace(/Id$/, "")),
        }));
    }
    catch {
        return [];
    }
}
async function resolveRecordTypes(ids, org, workspaceRoot) {
    if (ids.length === 0) {
        return new Map();
    }
    const idList = ids.map(id => `'${id}'`).join(",");
    try {
        const { stdout } = await (0, SfCli_1.execSf)(["data", "query",
            "--query", `SELECT Id, DeveloperName FROM RecordType WHERE Id IN (${idList})`,
            "--target-org", org,
            "--json"], { cwd: workspaceRoot, timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
        const parsed = JSON.parse(stdout);
        const records = parsed?.result?.records ?? [];
        return new Map(records.map(r => [r.Id, r.DeveloperName]));
    }
    catch {
        return new Map();
    }
}
// ---------------------------------------------------------------------------
// pullData
// ---------------------------------------------------------------------------
async function pullData(sourceOrg, workspaceRoot, config, onLog, onProgress, controller, options) {
    const ctrl = asInternal(controller);
    const objects = activeObjects(config);
    const seedDir = resolvedSeedDir(workspaceRoot, config, options);
    const startMs = Date.now();
    (0, DataMigrationConfig_1.ensureDmDirs)(workspaceRoot, config.seedDir);
    fs.mkdirSync(seedDir, { recursive: true });
    const pulledObjects = [];
    const dependencyGraph = {};
    const referenceFieldsMap = {};
    for (let i = 0; i < objects.length; i++) {
        if (ctrl.state === "cancelled") {
            break;
        }
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
        let records = [];
        let pullSuccess = false;
        for (let attempt = 0; attempt <= 20; attempt++) {
            let rawMsg = "";
            try {
                const { stdout } = await (0, SfCli_1.execSf)(["data", "query", "--query", query, "--target-org", sourceOrg, "--json"], { cwd: workspaceRoot, timeout: 300000, maxBuffer: 100 * 1024 * 1024 });
                const parsed = JSON.parse(stdout);
                if (parsed.status !== 0) {
                    rawMsg = String(parsed.message ?? "unknown error");
                }
                else {
                    const raw = parsed?.result?.records ?? [];
                    records = raw.map(({ attributes: _a, ...rest }) => rest);
                    pullSuccess = true;
                    break;
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
                        onLog(`⚠️  Auto-removed unknown field '${badField}' from ${obj.sobject} SOQL — retrying…`, "warn");
                        query = healed;
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
                    status: idx < i ? "done" : idx === i ? "skipped" : "pending",
                    created: 0, total: 1,
                })),
                elapsedMs: elapsed, estimatedRemainingMs: 0,
            });
            continue;
        }
        if (!options?.dryRun) {
            const rtIds = [...new Set(records.filter(r => r.RecordTypeId && typeof r.RecordTypeId === "string")
                    .map(r => r.RecordTypeId))];
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
            const deps = [...new Set(refFields
                    .flatMap(f => f.referenceTo)
                    .filter(t => objects.some(o => o.sobject === t)))];
            dependencyGraph[obj.sobject] = deps;
        }
        else {
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
                status: idx < i ? "done" : idx === i ? "running" : "pending",
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
// Load data helpers
// ---------------------------------------------------------------------------
/** Minimal RFC4180 CSV parser — handles quoted fields with embedded commas, quotes, and
 *  newlines, which Bulk API 2.0's `sf__Error` column regularly contains (e.g. messages that
 *  themselves list comma-separated field names). Returns one object per data row, keyed by
 *  header. */
function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++;
                }
                else {
                    inQuotes = false;
                }
            }
            else {
                field += c;
            }
        }
        else if (c === '"') {
            inQuotes = true;
        }
        else if (c === ",") {
            row.push(field);
            field = "";
        }
        else if (c === "\n" || c === "\r") {
            if (c === "\r" && text[i + 1] === "\n") {
                i++;
            }
            row.push(field);
            field = "";
            rows.push(row);
            row = [];
        }
        else {
            field += c;
        }
    }
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    const nonEmptyRows = rows.filter(r => !(r.length === 1 && r[0] === ""));
    if (nonEmptyRows.length === 0) {
        return [];
    }
    const headers = nonEmptyRows[0];
    return nonEmptyRows.slice(1).map(r => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = r[i] ?? ""; });
        return obj;
    });
}
function buildUpsertCsv(records, obj, referenceFields, objByName) {
    if (records.length === 0 || !obj.externalIdField) {
        return "";
    }
    const lookupToRelCol = new Map();
    for (const rf of referenceFields) {
        if (rf.field === "RecordTypeId") {
            lookupToRelCol.set("RecordTypeId", "RecordType.DeveloperName");
            continue;
        }
        const parentSobject = rf.referenceTo.find(t => objByName.has(t));
        if (!parentSobject) {
            continue;
        }
        const parentCfg = objByName.get(parentSobject);
        if (!parentCfg?.externalIdField) {
            continue;
        }
        lookupToRelCol.set(rf.field, `${rf.relationshipName}.${parentCfg.externalIdField}`);
    }
    const lookupFields = new Set(lookupToRelCol.keys());
    const directFields = new Set();
    const relColsOrdered = [];
    const relColSet = new Set();
    for (const record of records) {
        for (const key of Object.keys(record)) {
            if (key === "Id") {
                continue;
            }
            if (lookupFields.has(key)) {
                const relCol = lookupToRelCol.get(key);
                if (!relColSet.has(relCol)) {
                    relColSet.add(relCol);
                    relColsOrdered.push(relCol);
                }
            }
            else {
                directFields.add(key);
            }
        }
    }
    const headers = [obj.externalIdField, ...Array.from(directFields), ...relColsOrdered];
    const relColToLookupField = new Map([...lookupToRelCol.entries()].map(([k, v]) => [v, k]));
    const rows = records.map(record => {
        return headers.map(h => {
            if (h === obj.externalIdField) {
                return csvEscape(String(record.Id ?? ""));
            }
            if (relColSet.has(h)) {
                const lookupField = relColToLookupField.get(h);
                if (!lookupField) {
                    return "";
                }
                const raw = record[lookupField];
                if (!raw) {
                    return "";
                }
                if (lookupField === "RecordTypeId" && typeof raw === "string" && raw.startsWith("__RecordType__")) {
                    return csvEscape(raw.slice("__RecordType__".length));
                }
                return csvEscape(String(raw));
            }
            const val = record[h];
            if (val === null || val === undefined) {
                return "";
            }
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
async function fetchBulkJobAllResults(jobId, targetOrg, tmpDir, extField, emit) {
    try {
        const { stdout } = await (0, SfCli_1.execSf)(["data", "bulk", "results", "--job-id", jobId, "--target-org", targetOrg, "--json"], { cwd: tmpDir, timeout: 60000, maxBuffer: 20 * 1024 * 1024 });
        const parsed = JSON.parse(stdout);
        const successes = [];
        const failures = [];
        const successFilePath = parsed?.result?.successFilePath;
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
            else {
                emit(`  ⚠ Bulk job ${jobId}: success-results file was reported but not found at ${csvPath}`, "warn");
            }
        }
        const failedFilePath = parsed?.result?.failedFilePath;
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
            else {
                emit(`  ⚠ Bulk job ${jobId}: failed-results file was reported but not found at ${csvPath}`, "warn");
            }
        }
        if (!successFilePath && !failedFilePath) {
            emit(`  ⚠ Bulk job ${jobId}: "sf data bulk results" returned no result file paths — real per-record errors unavailable. Raw response: ${stdout.slice(0, 300)}`, "warn");
        }
        for (const suffix of ["-success-records.csv", "-failed-records.csv", "-unprocessed-records.csv"]) {
            try {
                fs.unlinkSync(path.join(tmpDir, `${jobId}${suffix}`));
            }
            catch { /* ignore */ }
        }
        return { successes, failures };
    }
    catch (e) {
        // Previously swallowed entirely — the caller fell back to the CLI's generic
        // "N records failed" summary with no explanation of why the detail fetch itself
        // failed (e.g. the job wasn't actually done yet, or auth expired mid-run).
        emit(`  ⚠ Could not fetch real per-record errors for bulk job ${jobId}: ${e?.message ?? String(e)}`, "warn");
        emit(`  → Run manually to inspect: sf data bulk results --job-id ${jobId} --target-org ${targetOrg}`, "info");
        return null;
    }
}
function readSeedRecords(seedDir, sobject) {
    const fp = path.join(seedDir, `${sobject}.json`);
    if (!fs.existsSync(fp)) {
        return [];
    }
    try {
        const raw = JSON.parse(fs.readFileSync(fp, "utf-8"));
        return (raw?.records ?? (Array.isArray(raw) ? raw : []));
    }
    catch {
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
function parseImportResult(stdout) {
    const created = [];
    const createdByRef = new Map();
    const failed = [];
    const resultItems = [];
    let limitException = false;
    try {
        const parsed = JSON.parse(stdout);
        // Top-level CLI error (e.g. bad flag, auth failure) has no `result` key at all — surface
        // its message instead of silently reporting "0 created, N failed" with no detail. For a
        // Bulk API 2.0 job that completed with failures, this is ALWAYS just the generic
        // "Job finished being processed but failed to process N records." — the real per-record
        // reasons live in a separate `sf data bulk results` call keyed by `data.jobId`.
        if (parsed?.result === undefined && typeof parsed?.message === "string") {
            const errStr = parsed.message;
            if (errStr.includes("LimitException")) {
                limitException = true;
            }
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
                // Bulk upsert reports `created: false` for a row that matched an existing
                // record and was updated rather than inserted. Import tree has no such concept
                // (every row it returns is a genuine new record) — item.created is absent there,
                // so this defaults to true.
                const wasNewRecord = item.created !== false;
                resultItems.push({ sfId, success: true, error: "", wasNewRecord });
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
                resultItems.push({ sfId: "", success: false, error: errStr, wasNewRecord: false });
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
function kahnSort(nodes, deps) {
    const indeg = new Map(nodes.map(n => [n, 0]));
    for (const node of nodes) {
        for (const _dep of deps[node] ?? []) {
            indeg.set(node, (indeg.get(node) ?? 0) + 1);
        }
    }
    const queue = nodes.filter(n => (indeg.get(n) ?? 0) === 0);
    const result = [];
    while (queue.length > 0) {
        const node = queue.shift();
        result.push(node);
        for (const other of nodes) {
            if ((deps[other] ?? []).includes(node)) {
                const d = (indeg.get(other) ?? 1) - 1;
                indeg.set(other, d);
                if (d === 0) {
                    queue.push(other);
                }
            }
        }
    }
    for (const n of nodes) {
        if (!result.includes(n)) {
            result.push(n);
        }
    }
    return result;
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
    const tmpDir = path.join(workspaceRoot, ".git", "sf-devops-dm", "tmp-load");
    fs.mkdirSync(tmpDir, { recursive: true });
    let planDeps = {};
    let planRefFields = {};
    const planPath = path.join(seedDir, "plan.json");
    if (fs.existsSync(planPath)) {
        try {
            const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
            planDeps = plan.dependencies ?? {};
            planRefFields = plan.referenceFields ?? {};
        }
        catch { /* ignore */ }
    }
    const allActive = activeObjects(config);
    if (!dryRun) {
        emit(`Pre-flight: verifying ExternalId fields on ${allActive.length} object(s)…`, "info");
        let preflightOk = true;
        const chunks = chunkArray(allActive, 5);
        for (const chunk of chunks) {
            const results = await Promise.allSettled(chunk.map(obj => checkExternalId(targetOrg, obj.sobject, workspaceRoot, () => { })));
            for (let j = 0; j < chunk.length; j++) {
                const obj = chunk[j];
                const r = results[j];
                const found = r.status === "fulfilled" ? r.value : null;
                if (!found) {
                    emit(`✗ ${obj.sobject}: ExternalId field '${obj.externalIdField ?? "(none configured)"}' not found in target org`, "error");
                    preflightOk = false;
                }
                else {
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
    const depGraph = {};
    for (const obj of allActive) {
        const planDep = planDeps[obj.sobject] ?? [];
        const configDep = obj.dependsOn ?? [];
        depGraph[obj.sobject] = [...new Set([...planDep, ...configDep])].filter(d => allActive.some(o => o.sobject === d));
    }
    const sortedNames = kahnSort(allActive.map(o => o.sobject), depGraph);
    const objectsToProcess = sortedNames
        .map(name => allActive.find(o => o.sobject === name))
        .filter(Boolean);
    emit(`Load order: ${objectsToProcess.map(o => o.sobject).join(" → ")}`, "info");
    const objByName = new Map(allActive.map(o => [o.sobject, o]));
    let objectList = objectsToProcess;
    if (options?.objectFilter && options.objectFilter.length > 0) {
        const needed = new Set();
        const addWithDeps = (sobject) => {
            if (needed.has(sobject)) {
                return;
            }
            needed.add(sobject);
            for (const dep of depGraph[sobject] ?? []) {
                addWithDeps(dep);
            }
        };
        for (const s of options.objectFilter) {
            addWithDeps(s);
        }
        objectList = objectsToProcess.filter(o => needed.has(o.sobject));
    }
    let tracking = (0, DataMigrationConfig_1.readTracking)(workspaceRoot, targetOrg);
    let totalLoaded = 0, totalFailed = 0, totalSkipped = 0, totalBlocked = 0;
    const objStatusMap = new Map();
    for (const obj of objectList) {
        objStatusMap.set(obj.sobject, { status: "pending", created: 0, updated: 0, alreadyDone: 0, total: 0, failed: 0, skipped: 0 });
    }
    let cachedGrandTotal = null;
    const buildProgressEvent = (obj, objIdx, batchIdx, batchCount, batchDone, _batchTotal) => {
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
                return { sobject: o.sobject, status: s.status, created: s.created ?? 0, total: s.total ?? 0 };
            }),
            elapsedMs,
            estimatedRemainingMs,
        };
    };
    for (let objIdx = 0; objIdx < objectList.length; objIdx++) {
        if (stateOf(ctrl) === "cancelled") {
            (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
            break;
        }
        if (stateOf(ctrl) === "paused") {
            await waitForResume(controller, onLog);
        }
        const obj = objectList[objIdx];
        objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject), status: "running" });
        emit(`Loading ${obj.sobject} (${objIdx + 1}/${objectList.length})...`, "info");
        let refFields = planRefFields[obj.sobject] ?? [];
        if (refFields.length === 0 && !dryRun) {
            refFields = await getReferenceFields(obj.sobject, targetOrg, workspaceRoot);
        }
        const allRecords = readSeedRecords(seedDir, obj.sobject);
        if (allRecords.length === 0) {
            emit(`No seed records found for ${obj.sobject} — skipping`, "warn");
            objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject), status: "skipped" });
            continue;
        }
        if (!tracking[obj.sobject]) {
            tracking[obj.sobject] = {};
        }
        objStatusMap.get(obj.sobject).total = allRecords.length;
        const batches = chunkArray(allRecords, config.batchSize);
        for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
            if (stateOf(ctrl) === "cancelled") {
                (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
                return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked };
            }
            if (stateOf(ctrl) === "paused") {
                await waitForResume(controller, onLog);
            }
            if (ctrl._consumeSkip()) {
                for (const rec of batches.slice(batchIdx).flat()) {
                    const srcId = String(rec.Id ?? `${obj.sobject}_${batchIdx}`);
                    if (tracking[obj.sobject][srcId]?.status !== "created") {
                        tracking[obj.sobject][srcId] = { status: "skipped", at: now() };
                        totalSkipped++;
                        objStatusMap.get(obj.sobject).skipped++;
                    }
                }
                break;
            }
            const batch = batches[batchIdx];
            const toLoad = [];
            for (const rec of batch) {
                const srcId = String(rec.Id ?? "");
                if (tracking[obj.sobject][srcId]?.status === "created") {
                    objStatusMap.get(obj.sobject).alreadyDone++;
                }
                else {
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
            await loadBatch(obj, toLoad, targetOrg, workspaceRoot, tmpDir, tracking, refFields, objByName, emit, (created, updated, failed) => {
                totalLoaded += created + updated;
                totalFailed += failed;
                const s = objStatusMap.get(obj.sobject);
                s.created += created;
                s.updated += updated;
                s.failed += failed;
            }, config.batchSize);
            (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
            onProgress(buildProgressEvent(obj, objIdx, batchIdx, batches.length, toLoad.length, batch.length));
        }
        (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
        objStatusMap.set(obj.sobject, { ...objStatusMap.get(obj.sobject), status: "done" });
        emit(`✓ ${obj.sobject}: ${summarizeObjectResult(objStatusMap.get(obj.sobject))}`, "success");
    }
    const summaryParts = [`${totalLoaded} pushed`];
    if (totalFailed > 0) {
        summaryParts.push(`${totalFailed} failed`);
    }
    if (totalSkipped > 0) {
        summaryParts.push(`${totalSkipped} skipped`);
    }
    if (totalBlocked > 0) {
        summaryParts.push(`${totalBlocked} blocked`);
    }
    emit(`─── Load complete: ${summaryParts.join(" · ")} ───`, totalFailed > 0 ? "warn" : "success");
    if (dryRun) {
        const reportPath = path.join(workspaceRoot, ".git", "sf-devops-dm", "dryrun", "report.json");
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: now(), targetOrg, totalLoaded, totalFailed, totalSkipped, totalBlocked }, null, 2), "utf-8");
    }
    (0, DataMigrationConfig_1.writeLastRunLog)(workspaceRoot, logLines);
    (0, DataMigrationConfig_1.appendHistoryEntry)(workspaceRoot, { at: now(), op: "load", targetOrg, dryRun, loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked });
    ctrl._setState("done");
    return { loaded: totalLoaded, failed: totalFailed, skipped: totalSkipped, blocked: totalBlocked };
}
// ---------------------------------------------------------------------------
// loadBatch — always-upsert via Bulk API 2.0 with relationship columns
// ---------------------------------------------------------------------------
async function loadBatch(obj, records, targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize) {
    if (!obj.externalIdField) {
        emit(`✗ ${obj.sobject}: no externalIdField configured — skipping batch`, "error");
        onCount(0, 0, records.length);
        return;
    }
    if (records.length > maxBatchSize) {
        const half = Math.ceil(records.length / 2);
        await loadBatch(obj, records.slice(0, half), targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        await loadBatch(obj, records.slice(half), targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        return;
    }
    const csv = buildUpsertCsv(records, obj, referenceFields, objByName);
    if (!csv) {
        return;
    }
    const csvPath = path.join(tmpDir, `${(0, DataMigrationConfig_1.safeOrgName)(obj.sobject)}-${Date.now()}.csv`);
    let stdout = "";
    let attemptFailed = false;
    try {
        fs.writeFileSync(csvPath, csv, "utf-8");
        const result = await (0, SfCli_1.execSf)(["data", "upsert", "bulk",
            "--sobject", obj.sobject,
            "--external-id", obj.externalIdField,
            "--file", csvPath,
            "--target-org", targetOrg,
            "--wait", "10",
            "--json"], { cwd: workspaceRoot, timeout: 180000, maxBuffer: 50 * 1024 * 1024 });
        stdout = result.stdout;
    }
    catch (e) {
        stdout = e?.stdout ?? "";
        attemptFailed = true;
    }
    finally {
        if (fs.existsSync(csvPath)) {
            try {
                fs.unlinkSync(csvPath);
            }
            catch { /* ignore */ }
        }
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
                }
                else {
                    resultItems.push({ sfId: "", success: false, error: failure?.error ?? "Unknown error", wasNewRecord: false });
                }
            }
            if (resultItems.length > 0) {
                attemptFailed = false;
                failed = resultItems.filter(r => !r.success).map(r => ({ refId: "", error: r.error }));
            }
        }
    }
    if (limitException && records.length > 1) {
        const half = Math.ceil(records.length / 2);
        emit(`Governor limit hit for ${obj.sobject} batch of ${records.length} — splitting`, "warn");
        await loadBatch(obj, records.slice(0, half), targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        await loadBatch(obj, records.slice(half), targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        return;
    }
    let batchCreated = 0, batchUpdated = 0, batchFailed = 0;
    if (resultItems.length > 0 || !attemptFailed) {
        for (let i = 0; i < records.length; i++) {
            const sourceId = String(records[i].Id ?? `unknown-${i}`);
            const posResult = resultItems[i];
            if (posResult?.success) {
                tracking[obj.sobject][sourceId] = { status: "created", id: posResult.sfId, at: now() };
                if (posResult.wasNewRecord) {
                    batchCreated++;
                }
                else {
                    batchUpdated++;
                }
            }
            else {
                const err = posResult?.error ?? (attemptFailed ? "Batch failed" : "No result");
                tracking[obj.sobject][sourceId] = { status: "failed", error: err, at: now() };
                batchFailed++;
            }
        }
        onCount(batchCreated, batchUpdated, batchFailed);
        if (batchFailed > 0) {
            const parts = [];
            if (batchCreated > 0) {
                parts.push(`${batchCreated} created`);
            }
            if (batchUpdated > 0) {
                parts.push(`${batchUpdated} updated`);
            }
            if (parts.length === 0) {
                parts.push("0 created");
            }
            emit(`${obj.sobject}: ${parts.join(", ")}, ${batchFailed} failed in batch`, "warn");
            const seenErrors = new Set();
            for (const r of resultItems.filter(r => !r.success)) {
                const hint = parseFieldError(obj.sobject, r.error);
                const msg = hint ?? (r.error.length > 200 ? r.error.slice(0, 200) + "…" : r.error);
                if (msg && !seenErrors.has(msg)) {
                    seenErrors.add(msg);
                    emit(`  ${hint ? "→" : "✗"} ${msg}`, hint ? "warn" : "error");
                }
            }
        }
        else {
            const parts = [];
            if (batchCreated > 0) {
                parts.push(`${batchCreated} pushed ✓`);
            }
            if (batchUpdated > 0) {
                parts.push(`${batchUpdated} updated ✓`);
            }
            if (parts.length > 0) {
                emit(`  ${obj.sobject}: ${parts.join(", ")}`, "success");
            }
        }
    }
    else {
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
    // Final deps: use schema-based discovery
    // ------------------------------------------------------------------
    const finalDeps = schemaDeps;
    // ------------------------------------------------------------------
    // Topological sort — Kahn's algorithm
    // ------------------------------------------------------------------
    const inDegree = new Map();
    for (const o of objects) {
        inDegree.set(o.sobject, 0);
    }
    // For each node, in-degree = number of dependencies (objects that must load before it)
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
        let objDeleted = 0;
        let objDeleteFailed = 0;
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
                    objDeleted++;
                }
                else {
                    const err = (r?.errors ?? []).map((e) => e.message).join("; ") || "unknown";
                    tracking[obj.sobject][refId] = { status: "delete-failed", error: err, at: now() };
                    objDeleteFailed++;
                }
            }
        }
        catch (e) {
            onLog(`Delete bulk failed for ${obj.sobject}: ${e?.message ?? String(e)}`, "error");
            for (const [refId,] of createdEntries) {
                tracking[obj.sobject][refId] = { status: "delete-failed", error: e?.message ?? "execSf error", at: now() };
                objDeleteFailed++;
            }
        }
        deleted += objDeleted;
        deleteFailed += objDeleteFailed;
        fs.unlinkSync(csvPath);
        (0, DataMigrationConfig_1.writeTracking)(workspaceRoot, targetOrg, tracking);
        onLog(`✓ ${obj.sobject}: ${objDeleted} deleted`, "success");
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