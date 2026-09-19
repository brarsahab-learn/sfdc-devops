#!/usr/bin/env node
/**
 * Robust, resumable loader for seed/ into a target org.
 *
 * Tracks every record it creates (seed/.tracking/<org>.json) so:
 *   - Re-running only (re)attempts records that are pending or previously
 *     failed - already-created records are left alone.
 *   - --clear removes previously-created records (and their tracking) for
 *     one object or all of them, without reloading.
 *   - --reset does --clear then reloads.
 *   - --status prints a created/failed/pending table without touching the org.
 *
 * Usage:
 *   node data-migration/load-seed-data.js --target-org <org> [--object <Name[,Name...]|all>]
 *   node data-migration/load-seed-data.js --target-org <org> --clear [--object <Name[,Name...]|all>]
 *   node data-migration/load-seed-data.js --target-org <org> --reset [--object <Name[,Name...]|all>]
 *   node data-migration/load-seed-data.js --target-org <org> --status
 *
 * Object names are the unprefixed logical names from seed/plan.json
 * (Account, Product__c, Broker_Office_Location__c, ...), regardless of
 * whether the target org needs the InsureBridge__ namespace prefix.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { resolveNamespacePrefix, prefixCustomApiName } = require('./lib/namespace');
const { loadTracking, saveTracking } = require('./lib/tracking');

const SEED_DIR = path.join(__dirname, 'seed');
const PLAN_PATH = path.join(SEED_DIR, 'plan.json');
const BATCH_SIZE = 190; // stay under the Tree API's 200-records-per-request limit

function parseArgs(argv) {
    const opts = { object: 'all', reset: false, clear: false, status: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--target-org' || a === '-o') opts.targetOrg = argv[++i];
        else if (a === '--object') opts.object = argv[++i];
        else if (a === '--reset') opts.reset = true;
        else if (a === '--clear') opts.clear = true;
        else if (a === '--status') opts.status = true;
        else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    return opts;
}

function loadPlan() {
    return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8'));
}

function loadObjectRecords(file) {
    return JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), 'utf8')).records;
}

function summaryTable(plan, tracking) {
    const rows = [];
    for (const entry of plan) {
        const total = entry.files.reduce((n, f) => n + loadObjectRecords(f).length, 0);
        const t = tracking[entry.sobject] || {};
        let created = 0, failed = 0;
        for (const v of Object.values(t)) {
            if (v.status === 'created') created++;
            else if (v.status === 'failed') failed++;
        }
        rows.push({ sobject: entry.sobject, total, created, failed, pending: total - created - failed });
    }
    return rows;
}

function printTable(rows) {
    const cols = ['sobject', 'total', 'created', 'failed', 'pending'];
    const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
    const line = (vals) => vals.map((v, i) => String(v).padEnd(widths[i])).join('  ');
    console.log(line(cols));
    console.log(line(widths.map((w) => '-'.repeat(w))));
    for (const r of rows) {
        console.log(line(cols.map((c) => r[c])));
    }
}

function resolveTargetObjects(plan, requested) {
    if (requested === 'all') return plan.map((e) => e.sobject);
    const names = requested.split(',').map((s) => s.trim());
    const known = new Set(plan.map((e) => e.sobject));
    for (const n of names) {
        if (!known.has(n)) {
            console.error(`Unknown object '${n}'. Known objects: ${[...known].join(', ')}`);
            process.exit(1);
        }
    }
    return names;
}

/** Every object at or after the earliest requested one, in canonical order. */
function expandCascade(plan, requestedNames) {
    const order = plan.map((e) => e.sobject);
    const minIndex = Math.min(...requestedNames.map((n) => order.indexOf(n)));
    return order.slice(minIndex);
}

function deepSubstituteRefs(value, refIndex, missing) {
    if (Array.isArray(value)) {
        return value.map((v) => deepSubstituteRefs(v, refIndex, missing));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = deepSubstituteRefs(v, refIndex, missing);
        }
        return out;
    }
    if (typeof value === 'string' && /^@.+/.test(value)) {
        const refId = value.slice(1);
        if (refIndex.has(refId)) return refIndex.get(refId);
        missing.push(refId);
        return value;
    }
    return value;
}

function namespaceTransformRecord(record, nsPrefix) {
    const out = { attributes: { ...record.attributes } };
    if (out.attributes.type) {
        out.attributes.type = prefixCustomApiName(out.attributes.type, nsPrefix);
    }
    for (const [key, val] of Object.entries(record)) {
        if (key === 'attributes') continue;
        out[prefixCustomApiName(key, nsPrefix)] = val;
    }
    return out;
}

function clearObjects(targetOrg, plan, tracking, objectNames, nsPrefix) {
    // Children first, so we're not relying on cascade-delete semantics for
    // records that aren't ours.
    for (const sobject of [...objectNames].reverse()) {
        const t = tracking[sobject] || {};
        const ids = Object.values(t).filter((v) => v.status === 'created' && v.id).map((v) => v.id);
        if (ids.length === 0) {
            console.log(`==> ${sobject}: nothing tracked as created, nothing to delete`);
            tracking[sobject] = {};
            continue;
        }
        const namespacedSobject = prefixCustomApiName(sobject, nsPrefix);
        const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seed-clear-')), 'ids.csv');
        fs.writeFileSync(tmpFile, ['Id', ...ids].join('\n'));
        console.log(`==> ${sobject}: deleting ${ids.length} tracked record(s)`);
        try {
            const out = execFileSync('sf', [
                'data', 'delete', 'bulk',
                '--sobject', namespacedSobject,
                '--file', tmpFile,
                '--target-org', targetOrg,
                '--wait', '10',
                '--json',
            ], { encoding: 'utf8' });
            const parsed = JSON.parse(out);
            const jobInfo = (parsed.result && parsed.result.jobInfo) || {};
            const proc = jobInfo.numberRecordsProcessed || 0;
            const failed = jobInfo.numberRecordsFailed || 0;
            console.log(`    deleted=${proc - failed} failed=${failed} of ${ids.length}`);
        } catch (e) {
            console.error(`WARNING: bulk delete reported an error for ${sobject} - check org state before retrying. ${e.message}`);
        }
        tracking[sobject] = {};
    }
}

// Errors shaped like a per-transaction governor limit (not a per-record data
// problem) are worth retrying with a smaller batch - a big Tree API request
// inserts all its records in one transaction, so expensive per-record
// automation (flows, triggers) can blow limits like "too many SOQL queries"
// on a large batch that a smaller one would clear easily.
const LIMIT_ERROR_PATTERN = /LimitException|too many soql queries|CANNOT_EXECUTE_FLOW_TRIGGER/i;

/**
 * Inserts `records` (already namespace-transformed) for `sobject`, recording
 * results into `existing`/`counters`. On a governor-limit-shaped failure for
 * a batch of more than one record, splits it in half and retries each half
 * recursively, down to individual records if needed, instead of failing the
 * whole batch outright.
 */
function attemptRecords(sobject, targetOrg, records, nsPrefix, existing, counters, globalRefIndex) {
    if (records.length === 0) return;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-load-'));
    const dataFile = path.join(tmpDir, `${sobject}.json`);
    const planFile = path.join(tmpDir, 'plan.json');
    fs.writeFileSync(dataFile, JSON.stringify({ records }, null, 2));
    fs.writeFileSync(planFile, JSON.stringify([{ sobject: prefixCustomApiName(sobject, nsPrefix), files: [path.basename(dataFile)] }], null, 2));

    try {
        const out = execFileSync('sf', [
            'data', 'import', 'tree',
            '--plan', planFile,
            '--target-org', targetOrg,
            '--json',
        ], { encoding: 'utf8' });
        const parsed = JSON.parse(out);
        const results = parsed.result || [];
        const byRefId = new Map(results.map((r) => [r.refId || r.referenceId, r.id]));
        for (const record of records) {
            const refId = record.attributes.referenceId;
            const id = byRefId.get(refId);
            if (id) {
                existing[refId] = { status: 'created', id, at: new Date().toISOString() };
                globalRefIndex.set(refId, id);
                counters.created++;
            } else {
                existing[refId] = { status: 'failed', error: 'no result returned for this refId', at: new Date().toISOString() };
                counters.failed++;
            }
        }
    } catch (e) {
        const message = (e.stderr || e.stdout || e.message || 'unknown error').toString();
        if (records.length > 1 && LIMIT_ERROR_PATTERN.test(message)) {
            const mid = Math.ceil(records.length / 2);
            console.log(`    governor-limit-shaped error on a batch of ${records.length} - retrying as two smaller batches`);
            attemptRecords(sobject, targetOrg, records.slice(0, mid), nsPrefix, existing, counters, globalRefIndex);
            attemptRecords(sobject, targetOrg, records.slice(mid), nsPrefix, existing, counters, globalRefIndex);
            return;
        }
        const trimmed = message.slice(0, 500);
        for (const record of records) {
            const refId = record.attributes.referenceId;
            existing[refId] = { status: 'failed', error: trimmed, at: new Date().toISOString() };
            counters.failed++;
        }
    }
}

function loadObject(targetOrg, entry, tracking, globalRefIndex, nsPrefix) {
    const sobject = entry.sobject;
    const allRecords = entry.files.flatMap((f) => loadObjectRecords(f));
    const existing = tracking[sobject] || {};

    const pending = [];
    for (const record of allRecords) {
        const refId = record.attributes.referenceId;
        if (existing[refId] && existing[refId].status === 'created') continue; // already done
        pending.push(record);
    }

    const counters = { created: 0, failed: 0, blocked: 0 };

    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
        const batch = pending.slice(i, i + BATCH_SIZE);
        const resolvable = [];
        for (const record of batch) {
            const refId = record.attributes.referenceId;
            const missing = [];
            const substituted = deepSubstituteRefs(record, globalRefIndex, missing);
            if (missing.length > 0) {
                existing[refId] = { status: 'failed', error: `blocked: missing parent ref(s) ${missing.join(', ')}`, at: new Date().toISOString() };
                counters.blocked++;
                continue;
            }
            resolvable.push(namespaceTransformRecord(substituted, nsPrefix));
        }
        attemptRecords(sobject, targetOrg, resolvable, nsPrefix, existing, counters, globalRefIndex);
    }

    tracking[sobject] = existing;
    return { total: allRecords.length, created: counters.created, failed: counters.failed, blocked: counters.blocked, skipped: allRecords.length - pending.length };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.targetOrg) {
        console.error('Usage: node data-migration/load-seed-data.js --target-org <org> [--object <Name|all>] [--reset|--clear|--status]');
        process.exit(1);
    }

    const plan = loadPlan();
    const tracking = loadTracking(opts.targetOrg);

    if (opts.status) {
        printTable(summaryTable(plan, tracking));
        return;
    }

    const probeObject = plan.find((e) => e.sobject.endsWith('__c')).sobject;
    const nsPrefix = resolveNamespacePrefix(opts.targetOrg, probeObject);
    console.log(`==> Namespace prefix for '${opts.targetOrg}': '${nsPrefix || '(none)'}'`);

    const requested = resolveTargetObjects(plan, opts.object);
    const cascadeNames = (opts.clear || opts.reset) ? expandCascade(plan, requested) : requested;

    if (opts.clear || opts.reset) {
        clearObjects(opts.targetOrg, plan, tracking, cascadeNames, nsPrefix);
        saveTracking(opts.targetOrg, tracking);
        if (opts.clear && !opts.reset) {
            printTable(summaryTable(plan, tracking));
            return;
        }
    }

    // Loading (default action, or the reload half of --reset): always walk
    // the full canonical order so any not-yet-created prerequisite of a
    // requested object gets picked up automatically.
    const runList = opts.reset ? cascadeNames : plan.map((e) => e.sobject).filter((n, idx, arr) => {
        // include every object up through the last requested one, so
        // prerequisites are always attempted even if already fully loaded
        // (a no-op in that case - loadObject skips already-created records).
        const lastRequestedIdx = Math.max(...requested.map((r) => arr.indexOf(r)));
        return idx <= lastRequestedIdx;
    });

    const globalRefIndex = new Map();
    for (const [sobject, entries] of Object.entries(tracking)) {
        for (const [refId, v] of Object.entries(entries)) {
            if (v.status === 'created') globalRefIndex.set(refId, v.id);
        }
    }

    const results = [];
    for (const sobject of runList) {
        const entry = plan.find((e) => e.sobject === sobject);
        console.log(`==> Loading ${sobject}...`);
        const r = loadObject(opts.targetOrg, entry, tracking, globalRefIndex, nsPrefix);
        console.log(`    created=${r.created} failed=${r.failed} blocked=${r.blocked} skipped(already loaded)=${r.skipped} of total=${r.total}`);
        results.push({ sobject, ...r });
        saveTracking(opts.targetOrg, tracking); // persist after every object so a crash doesn't lose progress
    }

    console.log('\n=== Final status ===');
    printTable(summaryTable(plan, tracking));
}

main();
