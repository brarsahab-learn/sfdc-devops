#!/usr/bin/env node
/**
 * Refreshes seed/ (the tree-export data files + plan.json) from any
 * source org, and regenerates the Insurer name list baked into
 * data-migration/apex/fix-insurer-record-types.apex to match what was pulled.
 *
 * Which objects get pulled - and the query used for each - is controlled by
 * pull-objects.json, an editable list of { sobject, query } entries. Add,
 * remove, or edit entries there to change what a pull captures; no code
 * changes needed. The array's order is also the canonical dependency order
 * used to sequence seed/plan.json (and thus the load order) - list an
 * object's parents before it if your query references them via a lookup
 * (e.g. list Product_Group__c before Product__c, since Product__c.Product_Group__c
 * points at it).
 *
 * "query" is optional - an entry with just { sobject } gets a query
 * auto-built from that object's editable fields (describe's createable
 * fields), via buildAutoQuery() below. Auto-built queries deliberately drop
 * RecordTypeId and any reference field pointing at User/Group (Owner, etc.)
 * - those values aren't portable across orgs. Only Id + createable fields
 * are included; nothing filters by WHERE, so an auto-built query pulls every
 * record of that object. Write an explicit "query" for anything needing a
 * WHERE clause, a record-type-scoped fixup (see fix-insurer-record-types.apex
 * for the pattern), or relationship traversal for lookup auto-linking.
 *
 * Usage:
 *   node data-migration/pull-seed-data.js <source-org>
 *
 * Re-running data-migration/load-seed-data.js against any target org afterwards
 * always reflects whatever was last pulled here - there's no separate
 * "which org is the data from" state.
 *
 * NOTE: refIds are regenerated fresh from the new source data, so any
 * existing per-target-org load tracking (seed/.tracking/*.json) is no
 * longer meaningful and is cleared as part of a pull.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const [, , sourceOrg] = process.argv;
if (!sourceOrg) {
    console.error('Usage: node data-migration/pull-seed-data.js <source-org>');
    process.exit(1);
}

const SEED_DIR = path.join(__dirname, 'seed');
const TRACKING_DIR = path.join(SEED_DIR, '.tracking');
const APEX_PATH = path.join(__dirname, 'apex', 'fix-insurer-record-types.apex');
const PULL_OBJECTS_PATH = path.join(__dirname, 'pull-objects.json');

if (!fs.existsSync(PULL_OBJECTS_PATH)) {
    console.error(`Missing ${PULL_OBJECTS_PATH} - this file lists which objects to pull and how.`);
    process.exit(1);
}

let pullObjects;
try {
    pullObjects = JSON.parse(fs.readFileSync(PULL_OBJECTS_PATH, 'utf8'));
} catch (e) {
    console.error(`Failed to parse ${PULL_OBJECTS_PATH}: ${e.message}`);
    process.exit(1);
}
if (!Array.isArray(pullObjects) || pullObjects.length === 0) {
    console.error(`${PULL_OBJECTS_PATH} must be a non-empty JSON array of { sobject, query } entries.`);
    process.exit(1);
}
for (const [i, entry] of pullObjects.entries()) {
    const queryOk = entry.query === undefined || typeof entry.query === 'string';
    if (!entry || typeof entry.sobject !== 'string' || !queryOk) {
        console.error(`${PULL_OBJECTS_PATH}[${i}] must have a string "sobject", and an optional string "query". Got: ${JSON.stringify(entry)}`);
        process.exit(1);
    }
}

/**
 * Auto-builds "SELECT Id, <editable fields> FROM <sobject>" from the source
 * org's describe of that object. Excludes RecordTypeId and any User/Group
 * reference field (Owner, etc.) - those Ids aren't portable across orgs.
 */
function buildAutoQuery(sobject) {
    const out = execFileSync('sf', [
        'sobject', 'describe',
        '--sobject', sobject,
        '--target-org', sourceOrg,
        '--json',
    ], { encoding: 'utf8' });
    const fields = JSON.parse(out).result.fields;
    const names = fields
        .filter((f) => f.createable)
        .filter((f) => f.name !== 'RecordTypeId')
        .filter((f) => f.type !== 'base64')
        .filter((f) => !(f.type === 'reference' && (f.referenceTo || []).includes('User')))
        .map((f) => f.name);
    return `SELECT Id, ${names.join(', ')} FROM ${sobject}`;
}

// The file's order is also the canonical dependency order - anything that
// shows up in the export but isn't listed here (shouldn't happen, since we
// only ever query what's listed) gets appended at the end with a warning
// rather than silently dropped.
const CANONICAL_ORDER = pullObjects.map((e) => e.sobject);
const QUERIES = pullObjects.map((e) => {
    if (e.query) return e.query;
    console.log(`==> No query for '${e.sobject}' - auto-building one from its editable fields`);
    const q = buildAutoQuery(e.sobject);
    console.log(`    ${q}`);
    return q;
});

console.log(`==> Pulling ${pullObjects.length} object(s) per pull-objects.json: ${CANONICAL_ORDER.join(', ')}`);

console.log(`==> Exporting seed data tree from '${sourceOrg}'`);
// Export to a scratch directory first, and only replace seed/'s JSON files
// once the export has fully succeeded - a failed/partial export (e.g. wrong
// org, missing package metadata) must never wipe out already-working seed
// data.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-seed-data-'));

const args = ['data', 'export', 'tree'];
for (const q of QUERIES) {
    args.push('--query', q);
}
args.push('--output-dir', tmpDir, '--plan', '--target-org', sourceOrg);

execFileSync('sf', args, { stdio: 'inherit' });

// Reorder plan.json into canonical dependency order.
const tmpPlanPath = path.join(tmpDir, 'plan.json');
const plan = JSON.parse(fs.readFileSync(tmpPlanPath, 'utf8'));
const bySobject = new Map(plan.map((e) => [e.sobject, e]));
const ordered = [];
for (const name of CANONICAL_ORDER) {
    if (bySobject.has(name)) {
        ordered.push(bySobject.get(name));
        bySobject.delete(name);
    }
}
if (bySobject.size > 0) {
    console.warn(`WARNING: unexpected sobjects in export not in CANONICAL_ORDER, appending at end: ${[...bySobject.keys()].join(', ')}`);
    ordered.push(...bySobject.values());
}
fs.writeFileSync(tmpPlanPath, JSON.stringify(ordered, null, 4) + '\n');

// Export succeeded - now safe to replace seed/'s generated files. Clear out
// old *.json first (including any left over from an object that's since
// been removed from pull-objects.json), then move the fresh ones in.
fs.mkdirSync(SEED_DIR, { recursive: true });
for (const f of fs.readdirSync(SEED_DIR)) {
    if (f.endsWith('.json')) {
        fs.rmSync(path.join(SEED_DIR, f));
    }
}
for (const f of fs.readdirSync(tmpDir)) {
    fs.renameSync(path.join(tmpDir, f), path.join(SEED_DIR, f));
}
fs.rmSync(tmpDir, { recursive: true, force: true });

// Regenerate the Insurer name list baked into fix-insurer-record-types.apex.
const accountFile = path.join(SEED_DIR, 'Account.json');
if (fs.existsSync(accountFile)) {
    const accounts = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
    const names = accounts.records.map((r) => r.Name).sort();
    const apexList = names.map((n) => `    '${n.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`).join(',\n');
    let apexSrc = fs.readFileSync(APEX_PATH, 'utf8');
    apexSrc = apexSrc.replace(
        /List<String> insurerNames = new List<String>\{[\s\S]*?\};/,
        `List<String> insurerNames = new List<String>{\n${apexList}\n};`
    );
    fs.writeFileSync(APEX_PATH, apexSrc);
    console.log(`==> Updated ${names.length} Insurer names in data-migration/apex/fix-insurer-record-types.apex`);
}

// Any existing tracking is keyed against the old data's refIds - no longer valid.
if (fs.existsSync(TRACKING_DIR)) {
    fs.rmSync(TRACKING_DIR, { recursive: true, force: true });
    console.log('==> Cleared seed/.tracking/ (refIds changed - old tracking no longer applies)');
}

console.log(`==> Pull complete. Seed data now reflects '${sourceOrg}'.`);
