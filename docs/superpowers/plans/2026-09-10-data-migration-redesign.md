# Data Migration Engine Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `@refId` synthetic-reference / in-memory substitution system with source-org record IDs as ExternalId values and Salesforce Bulk API relationship columns for cross-object reference resolution.

**Architecture:** Pull uses `sf data query` per object, storing flat JSON with real source IDs. Load always upserts keyed on the configured ExternalId field; lookup columns in the CSV use SF relationship notation (`Account.External_Id__c`, `Parent__r.External_Id__c`) so SF resolves parent records natively at upsert time — session-independent and no in-memory mapping required.

**Tech Stack:** TypeScript, VS Code Extension API, Salesforce CLI (`sf data query`, `sf data upsert bulk`), Bulk API 2.0

**Spec:** `docs/superpowers/specs/2026-09-10-data-migration-redesign.md`

## Global Constraints

- No new npm dependencies — use only what is already imported
- TypeScript must compile with zero errors after every task: `npx tsc --noEmit`
- No ExternalId field creation of any kind — the extension only verifies fields exist
- All loads are always upserts — the insert path (`sf data import tree`) is completely removed
- Tracking keys change from synthetic `refId` to source org record ID (`record.Id`)
- Seed files always named `{Sobject}.json` (not plural, not timestamped)
- Extension does not create or modify Salesforce object schemas

---

## File Map

| File | What changes |
|---|---|
| `src/DataMigrationConfig.ts` | Remove `autoCreateExternalId` from `DmConfig`; remove `externalIdVerified` from `DmObjectConfig` |
| `src/DataMigrationEngine.ts` | Delete 7 functions; rewrite `pullData`, `loadData`, `loadBatch`; add `resolveRecordTypes`, `buildUpsertCsv`; update `getReferenceFields` |
| `src/providers/DataMigrationPanel.ts` | Remove create/auto-create message handlers and UI; update ExternalIds tab; update Tracking tab labels |

---

## Task 1: Update DataMigrationConfig.ts types

**Files:**
- Modify: `src/DataMigrationConfig.ts`

**Interfaces:**
- Produces:
  ```typescript
  interface DmObjectConfig {
      id: string;
      sobject: string;
      label?: string;
      query: string;
      active: boolean;
      order: number;
      dependsOn?: string[];
      externalIdField?: string;       // externalIdVerified REMOVED
  }
  interface DmConfig {
      objects: DmObjectConfig[];      // autoCreateExternalId REMOVED
      seedDir: string;
      batchSize: number;
  }
  ```

- [ ] **Step 1: Remove `autoCreateExternalId` from `DmConfig` and its default**

In `src/DataMigrationConfig.ts`, change:
```typescript
export interface DmConfig {
    autoCreateExternalId: boolean;
    objects:              DmObjectConfig[];
    seedDir:              string;
    batchSize:            number;
}
```
to:
```typescript
export interface DmConfig {
    objects:  DmObjectConfig[];
    seedDir:  string;
    batchSize: number;
}
```

- [ ] **Step 2: Remove `externalIdVerified` from `DmObjectConfig`**

Change:
```typescript
export interface DmObjectConfig {
    id:                  string;
    sobject:             string;
    label?:              string;
    query:               string;
    active:              boolean;
    order:               number;
    dependsOn?:          string[];
    externalIdField?:    string;
    externalIdVerified?: boolean;
}
```
to:
```typescript
export interface DmObjectConfig {
    id:               string;
    sobject:          string;
    label?:           string;
    query:            string;
    active:           boolean;
    order:            number;
    dependsOn?:       string[];
    externalIdField?: string;
}
```

- [ ] **Step 3: Update `DEFAULT_CONFIG` and `readDmConfig`**

Remove `autoCreateExternalId` from `DEFAULT_CONFIG`:
```typescript
const DEFAULT_CONFIG: DmConfig = {
    objects:   [],
    seedDir:   ".git/sf-devops-dm/seed",
    batchSize: 190,
};
```

In `readDmConfig`, remove the `autoCreateExternalId` line from the returned object:
```typescript
return {
    objects:   parsed.objects   ?? [],
    seedDir:   parsed.seedDir   ?? DEFAULT_CONFIG.seedDir,
    batchSize: parsed.batchSize ?? 190,
};
```

- [ ] **Step 4: Compile check**
```bash
cd /Users/hardeep.brar/Code\ \(L\)/GitHub/sfdc-devops && npx tsc --noEmit 2>&1
```
Fix any errors (DataMigrationPanel.ts likely references `autoCreateExternalId` or `externalIdVerified` — comment those lines out with `// TODO Task 6` so the build passes now).

- [ ] **Step 5: Commit**
```bash
git add src/DataMigrationConfig.ts src/providers/DataMigrationPanel.ts
git commit -m "Remove autoCreateExternalId and externalIdVerified from DM types"
```

---

## Task 2: Delete dead engine functions + update `getReferenceFields`

**Files:**
- Modify: `src/DataMigrationEngine.ts`

**Interfaces:**
- Produces:
  ```typescript
  // Updated return type — adds relationshipName
  type RefField = { field: string; referenceTo: string[]; relationshipName: string };
  async function getReferenceFields(sobject: string, org: string, workspaceRoot: string): Promise<RefField[]>
  ```

- [ ] **Step 1: Delete these functions entirely from `DataMigrationEngine.ts`**

Delete each function body and its preceding comment block:
- `buildIdToRefMap` (line ~455) — full function
- `resolveObjectLookupRefs` (line ~471) — full function + its block comment
- `createExternalIdField` (line ~579) — full function
- `substituteRefs` (line ~674) — full function
- `applyNamespace` (line ~701) — full function + its comment
- `backfillExternalIds` (line ~1334) — full function + its comment block
- `detectNamespace` (line ~649) — full function
- `countExportedRecords` (line ~194) — full function

Also delete `buildCsv` (line ~715) — it will be replaced by `buildUpsertCsv` in Task 4.

- [ ] **Step 2: Update `getReferenceFields` to include `relationshipName`**

Replace:
```typescript
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
```
with:
```typescript
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
                relationshipName: (f.relationshipName ?? f.name.replace(/Id$/, "")) as string,
            }));
    } catch {
        return [];
    }
}
```

- [ ] **Step 3: Update `readSeedRecords` to use the new flat `{Sobject}.json` format**

Replace the existing `readSeedRecords` function:
```typescript
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
```

- [ ] **Step 4: Compile check**
```bash
cd /Users/hardeep.brar/Code\ \(L\)/GitHub/sfdc-devops && npx tsc --noEmit 2>&1
```
Expect errors in `pullData` and `loadData` that reference the deleted functions — leave them for Tasks 3 and 5. Fix any other errors now.

- [ ] **Step 5: Commit**
```bash
git add src/DataMigrationEngine.ts
git commit -m "Remove dead engine functions; add relationshipName to getReferenceFields"
```

---

## Task 3: Rewrite `pullData` with `sf data query` + RecordType resolution

**Files:**
- Modify: `src/DataMigrationEngine.ts`

**Interfaces:**
- Consumes: `getReferenceFields` → `RefField[]` (from Task 2)
- Produces:
  ```typescript
  // plan.json written to seedDir:
  interface PlanJson {
      generatedAt: string;
      sourceOrg:   string;
      objects:     string[];
      dependencies: Record<string, string[]>;
      referenceFields: Record<string, RefField[]>;
  }
  // Seed file per object: seedDir/{Sobject}.json
  // { records: [{ Id: "001XXX", Name: "...", AccountId: "003YYY", RecordTypeId: "__RecordType__Customer" }] }
  ```

- [ ] **Step 1: Add `resolveRecordTypes` helper**

Insert this function anywhere above `pullData`:
```typescript
/** Batch-queries source org for RecordType DeveloperNames. Returns a map of Id → DeveloperName. */
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
```

- [ ] **Step 2: Rewrite `pullData` completely**

Replace the entire `pullData` function with:
```typescript
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
        // Ensure Id is always selected
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
                    // Strip 'attributes' SF metadata wrapper; keep all user fields
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
                    status: idx < i ? "done" : idx === i ? "failed" : "pending",
                    created: 0, total: 1,
                })),
                elapsedMs: elapsed, estimatedRemainingMs: 0,
            });
            continue;
        }

        // RecordType resolution — replace RecordTypeId with DeveloperName marker
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

        // Write seed file
        const seedFile = path.join(seedDir, `${obj.sobject}.json`);
        fs.writeFileSync(seedFile, JSON.stringify({ records }, null, 2), "utf-8");
        onLog(`✓ Pulled ${obj.sobject}: ${records.length} record${records.length !== 1 ? "s" : ""}`, "success");
        pulledObjects.push(obj.sobject);

        // Build dependency graph from schema describe
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
                status: idx < i ? "done" : idx === i ? "running" : "pending",
                created: idx <= i ? 1 : 0, total: 1,
            })),
            elapsedMs, estimatedRemainingMs,
        });
    }

    // Write enriched plan.json
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
```

- [ ] **Step 3: Compile check**
```bash
cd /Users/hardeep.brar/Code\ \(L\)/GitHub/sfdc-devops && npx tsc --noEmit 2>&1
```
Fix any errors. Errors in `loadData` are expected — leave them for Task 5.

- [ ] **Step 4: Commit**
```bash
git add src/DataMigrationEngine.ts
git commit -m "Rewrite pullData: sf data query, source IDs, RecordType resolution, plan.json dependency graph"
```

---

## Task 4: Add `buildUpsertCsv`

**Files:**
- Modify: `src/DataMigrationEngine.ts`

**Interfaces:**
- Consumes: `RefField` (Task 2), `DmObjectConfig` (Task 1), `csvEscape` (existing)
- Produces:
  ```typescript
  function buildUpsertCsv(
      records:         Record<string, any>[],
      obj:             DmObjectConfig,
      referenceFields: RefField[],
      objByName:       Map<string, DmObjectConfig>,
  ): string
  ```

- [ ] **Step 1: Add `buildUpsertCsv` after the deleted `buildCsv` location (~line 715)**

```typescript
/**
 * Builds a Bulk API 2.0 CSV for an upsert operation.
 *
 * Columns:
 *  - ExternalId column: obj.externalIdField = record.Id  (source ID stamps the target record)
 *  - Relationship columns: for each lookup field whose parent is in the migration set
 *      Standard: AccountId  → Account.External_Id__c
 *      Custom:   Parent__c  → Parent__r.External_Id__c
 *      RecordType marker → RecordType.DeveloperName
 *  - Direct columns: all other scalar fields (Name, Email, etc.)
 *  Lookup field columns are omitted when replaced by a relationship column.
 *  Lookup fields with no resolvable parent are omitted (SF assigns field default).
 */
function buildUpsertCsv(
    records:         Record<string, any>[],
    obj:             DmObjectConfig,
    referenceFields: RefField[],
    objByName:       Map<string, DmObjectConfig>,
): string {
    if (records.length === 0 || !obj.externalIdField) { return ""; }

    // Build map: lookupFieldName → CSV relationship column header
    const lookupToRelCol = new Map<string, string>();
    for (const rf of referenceFields) {
        if (rf.field === "RecordTypeId") {
            lookupToRelCol.set("RecordTypeId", "RecordType.DeveloperName");
            continue;
        }
        // Find the first parent that is in the migration set and has an ExternalId field
        const parentSobject = rf.referenceTo.find(t => objByName.has(t));
        if (!parentSobject) { continue; }
        const parentCfg = objByName.get(parentSobject);
        if (!parentCfg?.externalIdField) { continue; }
        lookupToRelCol.set(rf.field, `${rf.relationshipName}.${parentCfg.externalIdField}`);
    }

    const lookupFields  = new Set(lookupToRelCol.keys());
    const directFields  = new Set<string>();
    const relColsOrdered: string[] = [];
    const relColSet     = new Set<string>();

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

    // Build reverse map: relCol → original lookup field (for value extraction)
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
                // RecordType stored as __RecordType__<DeveloperName>
                if (lookupField === "RecordTypeId" && typeof raw === "string" && raw.startsWith("__RecordType__")) {
                    return csvEscape(raw.slice("__RecordType__".length));
                }
                return csvEscape(String(raw));
            }
            // Direct field
            const val = record[h];
            if (val === null || val === undefined) { return ""; }
            return csvEscape(String(val));
        }).join(",");
    });

    return [headers.join(","), ...rows].join("\n");
}
```

- [ ] **Step 2: Compile check**
```bash
cd /Users/hardeep.brar/Code\ \(L\)/GitHub/sfdc-devops && npx tsc --noEmit 2>&1
```

- [ ] **Step 3: Commit**
```bash
git add src/DataMigrationEngine.ts
git commit -m "Add buildUpsertCsv with SF relationship column notation"
```

---

## Task 5: Rewrite `loadData` and `loadBatch`

**Files:**
- Modify: `src/DataMigrationEngine.ts`

**Interfaces:**
- Consumes: `buildUpsertCsv` (Task 4), `getReferenceFields` → `RefField[]` (Task 2), `DmObjectConfig.externalIdField` (Task 1)
- Tracking key: `record.Id` (source org ID) instead of synthetic `refId`

- [ ] **Step 1: Rewrite `loadBatch` — upsert-only, relationship columns**

Replace the entire `loadBatch` function:
```typescript
async function loadBatch(
    obj:             DmObjectConfig,
    records:         Record<string, any>[],   // source records (have .Id)
    targetOrg:       string,
    workspaceRoot:   string,
    tmpDir:          string,
    tracking:        TrackingFile,
    referenceFields: RefField[],
    objByName:       Map<string, DmObjectConfig>,
    emit:            LogFn,
    onCount:         (created: number, updated: number, failed: number) => void,
    maxBatchSize:    number,
): Promise<void> {
    if (!obj.externalIdField) {
        emit(`✗ ${obj.sobject}: no externalIdField configured — skipping batch`, "error");
        onCount(0, 0, records.length);
        return;
    }

    // Recursive governor-limit halving
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

    // Fetch per-record results from Bulk API job if available
    if (jobId && obj.externalIdField) {
        const allResults = await fetchBulkJobAllResults(jobId, targetOrg, tmpDir, obj.externalIdField);
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
            if (resultItems.length > 0) { attemptFailed = false; failed = resultItems.filter(r => !r.success).length; }
        }
    }

    if (limitException) {
        const half = Math.ceil(records.length / 2);
        emit(`Governor limit hit for ${obj.sobject} batch of ${records.length} — splitting`, "warn");
        await loadBatch(obj, records.slice(0, half), targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        await loadBatch(obj, records.slice(half),    targetOrg, workspaceRoot, tmpDir, tracking, referenceFields, objByName, emit, onCount, maxBatchSize);
        return;
    }

    // Map results back to tracking using record.Id as the key
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
```

- [ ] **Step 2: Rewrite `loadData` — always-upsert, dependency-ordered, no globalRefIndex**

Replace the entire `loadData` function:
```typescript
export async function loadData(
    targetOrg:     string,
    workspaceRoot: string,
    config:        DmConfig,
    onLog:         LogFn,
    onProgress:    ProgFn,
    controller:    DmRunController,
    options?:      DmRunOptions,
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

    // ── Load plan.json (may have richer dependency graph from pull) ──────────
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

    // ── Pre-flight: verify ExternalId fields exist in target org ─────────────
    const allActive = activeObjects(config);
    if (!dryRun) {
        emit(`Pre-flight: verifying ExternalId fields on ${allActive.length} object(s)…`, "info");
        let preflightOk = true;
        const chunkSize = 5;
        for (let i = 0; i < allActive.length; i += chunkSize) {
            const chunk = allActive.slice(i, i + chunkSize);
            const results = await Promise.allSettled(
                chunk.map(obj => checkExternalId(targetOrg, obj.sobject, workspaceRoot, () => {}))
            );
            for (let j = 0; j < chunk.length; j++) {
                const obj = chunk[j];
                const r   = results[j];
                const found = r.status === "fulfilled" ? r.value : null;
                if (!found) {
                    emit(`✗ ${obj.sobject}: ExternalId field '${obj.externalIdField ?? "(none configured)"}' not found in target org — configure it in SF Setup before loading`, "error");
                    preflightOk = false;
                } else {
                    obj.externalIdField = found;
                    emit(`✓ ${obj.sobject}: ExternalId field '${found}' verified`, "success");
                }
            }
        }
        if (!preflightOk) {
            emit("Pre-flight failed — fix ExternalId fields before loading", "error");
            ctrl._setState("done");
            return { loaded: 0, failed: 0, skipped: 0, blocked: 0 };
        }
    }

    // ── Build dependency-ordered object list ─────────────────────────────────
    // Merge plan.json deps + config dependsOn; topological sort
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

    // ── Build lookup maps ────────────────────────────────────────────────────
    const objByName = new Map<string, DmObjectConfig>(allActive.map(o => [o.sobject, o]));

    // Apply object filter (single-object re-run)
    let objectList = objectsToProcess;
    if (options?.objectFilter && options.objectFilter.length > 0) {
        const filterSet = new Set(options.objectFilter);
        const needed    = new Set<string>();
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

    for (let objIdx = 0; objIdx < objectList.length; objIdx++) {
        if (stateOf(ctrl) === "cancelled") { writeTracking(workspaceRoot, targetOrg, tracking); break; }
        if (stateOf(ctrl) === "paused")    { await waitForResume(controller, onLog); }

        const obj = objectList[objIdx];
        emit(`Loading ${obj.sobject} (${objIdx + 1}/${objectList.length})...`, "info");

        // Get reference fields from plan.json or live describe
        let refFields: RefField[] = planRefFields[obj.sobject] ?? [];
        if (refFields.length === 0 && !dryRun) {
            refFields = await getReferenceFields(obj.sobject, targetOrg, workspaceRoot);
        }

        const allRecords = readSeedRecords(seedDir, obj.sobject);
        if (allRecords.length === 0) {
            emit(`No seed records found for ${obj.sobject} — skipping`, "warn");
            objStatusMap.set(obj.sobject, { status: "skipped", created: 0, updated: 0, alreadyDone: 0, total: 0, failed: 0, skipped: 0 });
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

            // Filter out already-created records (idempotent re-run)
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
        emit(`✓ ${obj.sobject}: ${summarizeObjectResult(objStatusMap.get(obj.sobject)!)}`, "success");
    }

    // ── End-of-load summary ───────────────────────────────────────────────────
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
```

- [ ] **Step 3: Add `kahnSort` helper** (replaces the existing inline topological sort in autoSortByDependencies, or add as a standalone export for reuse):

Find the existing `kahnSort`-like logic inside `autoSortByDependencies` (~line 1580). Extract it into a named helper:
```typescript
function kahnSort(nodes: string[], deps: Record<string, string[]>): string[] {
    const inDegree = new Map<string, number>(nodes.map(n => [n, 0]));
    for (const [, depList] of Object.entries(deps)) {
        for (const dep of depList) {
            if (inDegree.has(dep)) { inDegree.set(dep, (inDegree.get(dep) ?? 0) + 1); }
        }
    }
    // Note: this is the reverse — nodes depended-ON should come first.
    // Rebuild with correct direction: node depends on its deps, so deps have lower order.
    const indeg = new Map<string, number>(nodes.map(n => [n, 0]));
    for (const [node, depList] of Object.entries(deps)) {
        if (!indeg.has(node)) { continue; }
        for (const dep of depList) {
            if (indeg.has(node)) { indeg.set(node, (indeg.get(node) ?? 0) + 1); }
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
    // Append any cycle nodes at the end
    for (const n of nodes) { if (!result.includes(n)) { result.push(n); } }
    return result;
}
```

- [ ] **Step 4: Compile check**
```bash
cd /Users/hardeep.brar/Code\ \(L\)/GitHub/sfdc-devops && npx tsc --noEmit 2>&1
```
Fix all remaining errors.

- [ ] **Step 5: Commit**
```bash
git add src/DataMigrationEngine.ts
git commit -m "Rewrite loadData + loadBatch: always-upsert, SF relationship columns, source-ID tracking keys"
```

---

## Task 6: Update DataMigrationPanel.ts UI

**Files:**
- Modify: `src/providers/DataMigrationPanel.ts`

- [ ] **Step 1: Remove message handlers for ExternalId field creation**

Delete (or comment out) these `case` blocks from the `webview.onDidReceiveMessage` handler:
- `case "createExtId":`
- `case "createAllExtIds":`
- Any handler that calls `createExternalIdField`

- [ ] **Step 2: Remove `autoCreateExternalId` toggle from config tab HTML**

Find the config tab render function and remove any checkbox/toggle for `autoCreateExternalId`. If the toggle's HTML contains something like `autoCreateExternalId`, delete that UI block.

- [ ] **Step 3: Simplify ExternalIds tab — remove create buttons**

In `renderExtIdsTab()`, change the per-row action to only show "Re-check"; remove the "Create" button and the "Auto-Create All Missing" button in the toolbar. The tab is now read-only status:
```typescript
const renderExtIdsTab = () => {
    const activeObjs = (config.objects ?? []).filter((o) => o.active !== false);
    if (activeObjs.length === 0) {
        return `<p style="color:var(--vscode-descriptionForeground)">No active objects configured.</p>`;
    }
    let rows = "";
    for (const obj of activeObjs) {
        const verified = obj.externalIdVerified ?? (obj.externalIdField ? undefined : false);
        const status = obj.externalIdField
            ? `<span class="badge badge-green">✅ ${esc(obj.externalIdField)}</span>`
            : `<span class="badge badge-amber">⚠️ Not configured — set externalIdField in config</span>`;
        rows += `<tr>
            <td><code>${esc(obj.sobject)}</code></td>
            <td>${status}</td>
            <td class="row-actions">
                <button class="btn btn-sm" ${dis} onclick="send('checkExtId',{sobject:${esc(JSON.stringify(obj.sobject))},targetOrg:${esc(JSON.stringify(targetOrg))}})">Re-check</button>
            </td>
        </tr>`;
    }
    return `
    <div class="table-wrap">
        <table class="data-table">
            <thead><tr><th>Object</th><th>External ID Field</th><th>Actions</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </div>
    <p style="font-size:11px;color:var(--vscode-descriptionForeground);margin-top:8px">
        ExternalId fields must be created manually in Salesforce Setup before loading data.
    </p>
    <div class="toolbar" style="margin-top:16px">
        <button class="btn btn-primary" ${dis} onclick="send('checkAllExtIds',{targetOrg:${esc(JSON.stringify(targetOrg))}})">Re-check All</button>
    </div>`;
};
```

- [ ] **Step 4: Update Tracking tab — change column label from "Ref ID" to "Source ID" if present**

Search for any column header labeled "Ref ID" or "RefId" in the tracking table and change to "Source ID". Also update any tooltip text that references `refId`.

- [ ] **Step 5: Remove `externalIdVerified` references from config save/load in the panel**

Search for any `externalIdVerified` in the panel and remove those assignments.

- [ ] **Step 6: Compile check**
```bash
cd /Users/hardeep.brar/Code\ \(L\)/GitHub/sfdc-devops && npx tsc --noEmit 2>&1
```
Fix all errors.

- [ ] **Step 7: Commit**
```bash
git add src/providers/DataMigrationPanel.ts
git commit -m "DM panel: remove ExternalId create UI; read-only ExternalIds tab; source-ID tracking labels"
```

---

## Task 7: Final verification + version bump

- [ ] **Step 1: Full compile check**
```bash
cd /Users/hardeep.brar/Code\ \(L\)/GitHub/sfdc-devops && npx tsc --noEmit 2>&1
```
Must be zero errors.

- [ ] **Step 2: Verify panel loads without JS errors**
Package and install the extension, open the Data Migration panel and check:
- Config tab: no `autoCreateExternalId` toggle
- ExternalIds tab: only Re-check / Re-check All buttons; no Create buttons
- Pull tab: pull an object → seed file written as `{Sobject}.json` with flat records, no `@refId` values
- Load tab: load runs; CSV logged (if debug) shows `Account.External_Id__c` columns; tracking keyed by source SF ID

- [ ] **Step 3: Package and bump version**
```bash
cd /Users/hardeep.brar/Code\ \(L\)/GitHub/sfdc-devops
# Update package.json version to 5.3.2-beta.1
npx vsce package --out salesforce-devops-5.3.2-beta.1.vsix
mv salesforce-devops-5.3.2-beta.1.vsix versions/
git add package.json versions/salesforce-devops-5.3.2-beta.1.vsix
git commit -m "5.3.2-beta.1 — Data migration redesign: source-ID ExternalId, SF relationship columns, always-upsert"
```
