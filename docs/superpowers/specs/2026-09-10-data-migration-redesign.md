# Data Migration Engine Redesign
**Date:** 2026-09-10  
**Status:** Approved — ready for implementation

---

## Problem

The existing pull/load pipeline has three fundamental flaws:

1. **Cross-session breakage** — cross-object reference resolution relies on an in-memory `globalRefIndex` (synthetic `@refId` → target SF ID). If records were loaded in a prior session, the mapping is gone and child records are "blocked".
2. **Synthetic reference system** — `sf data export tree` generates `@AccountRef001` placeholders that need a rewriting pass on every pull and a substitution pass on every load. This is an unnecessary layer of indirection.
3. **ExternalId field creation** — the extension creates Salesforce custom fields (`External_Id__c`) via Metadata API deploy. This is outside the extension's scope and has been a source of bugs.

---

## Solution — Approach A: SF Relationship Columns + Source-ID as ExternalId

### Core Insight

The source org record ID **is** the ExternalId value. No synthetic refs needed.

- Pull `Account` → `Id = "001XXX"` is stored as-is in seed data
- Load `Account` → write `External_Id__c = "001XXX"` on the target record
- Any child `Contact` with `AccountId = "001XXX"` in seed → CSV column `Account.External_Id__c = "001XXX"`
- Salesforce Bulk API resolves the parent natively — session-independent

---

## Pull Phase

### Mechanism Change

**Removed:** `sf data export tree` and the entire `@refId` placeholder system.  
**Replaced with:** `sf data query --query "..." --json` per object — flat records, real source IDs.

### Steps Per Object

1. Run `sf data query` with user-configured SOQL; auto-inject `Id` if missing
2. Store raw records as `{sobject}.json` in `seedDir` — source IDs intact
3. **RecordType resolution**: if any record has `RecordTypeId`, batch-query  
   `SELECT Id, DeveloperName FROM RecordType WHERE Id IN (...)` from source org.  
   Replace `RecordTypeId` with a synthetic marker `__RecordType__<DeveloperName>`  
   so the load phase writes `RecordType.DeveloperName = "..."` in the CSV.
4. Auto-heal loop: on FIELD_INTEGRITY error, strip the offending field from SOQL and retry (up to 20 attempts)

### Dependency Graph

During pull, call `sf sobject describe` for each object and record which fields are lookups to which parent objects. Store the derived dependency graph in `plan.json`.

### Seed File Format

```json
{ "records": [{ "Id": "001XXX", "Name": "Acme", "AccountId": "003YYY", "RecordTypeId": "__RecordType__Customer" }] }
```

### Plan.json Format

```json
{
  "generatedAt": "2026-09-10T12:00:00",
  "sourceOrg": "my-sandbox",
  "objects": ["Account", "Contact"],
  "dependencies": { "Contact": ["Account"], "Account": [] },
  "referenceFields": {
    "Contact": [
      { "field": "AccountId", "referenceTo": ["Account"], "relationshipName": "Account" }
    ]
  }
}
```

### Removed from Pull

- `buildIdToRefMap`
- `resolveObjectLookupRefs`
- `refFieldsBySobject`, `idMapsBySobject`
- All `@refId` placeholder rewriting
- `sf data export tree` invocation

---

## Load Phase

### Pre-flight (Per Object)

- Describe target org: verify `externalIdField` exists and is flagged `externalId: true`
- **If ExternalId field missing → fail fast with clear error. The extension does not create fields.**
- Derive dependency order from `plan.json` dependency graph + user `dependsOn` config, merged via Kahn's topological sort
- Log load order clearly

### Per-Object Load Loop (dependency order)

1. Read seed records from `{sobject}.json`
2. Check tracking → skip records already `created` (idempotent re-run)
3. Build upsert CSV via `buildUpsertCsv()`:
   - **ExternalId column**: `External_Id__c = record.Id`
   - **Relationship columns** (for each lookup field in seed data):
     - If parent is in migration set AND has `externalIdField` configured:
       - Standard lookup `AccountId` → `Account.External_Id__c = record.AccountId`
       - Custom lookup `Parent__c` → `Parent__r.External_Id__c = record.Parent__c`
     - RecordType marker → `RecordType.DeveloperName = "CustomerName"`
     - Unresolvable (parent not in migration, no ExternalId field) → **omit column** → SF assigns field default
   - **Direct columns**: all non-lookup fields (Name, Email, etc.) — copied as-is
   - Omit the original lookup field column when a relationship column replaces it
4. Upsert via Bulk API with `--external-id-field {externalIdField}`
5. On partial failure: surface per-record errors; mark failed records in tracking
6. On success: mark records `created` in tracking with target org SF ID

### Relationship Column Derivation Rules

| Lookup field | Column name |
|---|---|
| `AccountId` (standard) | `Account.External_Id__c` (strip `Id`, append `.{externalIdField}`) |
| `Parent__c` (custom) | `Parent__r.External_Id__c` (swap `__c` → `__r`, append `.{externalIdField}`) |
| `RecordTypeId` | `RecordType.DeveloperName` |
| Outside migration / no ExternalId | omit column |

### Tracking Key Change

Keys are now source org record IDs (the `Id` field from pulled data), not synthetic refIds.

```json
{
  "Account": {
    "001XXX": { "status": "created", "id": "001YYY", "at": "2026-09-10T12:00:00" }
  }
}
```

Where `001XXX` = source org ID, `001YYY` = target org ID.

---

## Data Structures

### `DmObjectConfig` Changes

**Removed:** `externalIdVerified`  
**Removed from UI and logic:** all ExternalId field auto-creation references  
**Kept:** `externalIdField` (user-configured; pre-flight validates it exists in target org)

### `DmConfig` Changes

**Removed:** `autoCreateExternalId`  
**Kept:** `seedDir`, `batchSize`, `objects`

---

## Functions Removed Entirely

| Function | Reason |
|---|---|
| `resolveObjectLookupRefs` | `@refId` system eliminated |
| `buildIdToRefMap` | `@refId` system eliminated |
| `substituteRefs` | `@refId` system eliminated |
| `globalRefIndex` | replaced by SF relationship columns |
| `backfillExternalIds` | extension never creates/stamps ExternalId fields |
| `createExternalIdField` | extension does not create SF fields |
| `checkExternalId` (creation path) | pre-flight verify-only; create path removed |
| `applyNamespace` | no longer needed without field creation |

---

## UI Changes (`DataMigrationPanel.ts`)

### ExternalIds Tab

- **Removed:** "Create" button per row, "Auto-Create All Missing" button
- **Removed:** `createExtId`, `createAllExtIds`, `createAllMissingExtIds` message handlers
- **Kept:** per-object verify status (calls describe, checks field exists) and "Re-check" / "Re-check All" buttons
- Tab is now read-only status — if field missing, user must create it manually in SF Setup

### Config Tab

- **Removed:** `autoCreateExternalId` toggle

### Load Tab

- **Removed:** insert-mode vs upsert-mode status display — always upsert
- Progress bars and log display unchanged

### Tracking Tab

- Source ID as row key (display label "Source ID" instead of "Ref ID")

---

## Files Changed

| File | Change type |
|---|---|
| `src/DataMigrationEngine.ts` | Major rewrite of `pullData`, `loadData`, `buildCsv`, `checkExternalId`; delete 6 functions |
| `src/DataMigrationConfig.ts` | Remove `autoCreateExternalId`; update `DmObjectConfig`; update tracking key semantics |
| `src/providers/DataMigrationPanel.ts` | Remove create/auto-create UI paths; update ExternalIds tab; update Tracking tab labels |

---

## Non-Goals

- The extension does not create Salesforce custom fields of any kind
- The extension does not modify object schemas in source or target orgs
- No changes to deployment, Git, pipeline, or any non-DM feature
