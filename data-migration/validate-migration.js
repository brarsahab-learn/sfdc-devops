#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs(argv) {
    const opts = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--target-org' || a === '-o') { opts.targetOrg = argv[++i]; }
        else if (a === '--ext-field') { opts.extField = argv[++i]; }
        else { console.error(`Unknown argument: ${a}`); process.exit(1); }
    }
    if (!opts.targetOrg) {
        console.error('Usage: node validate-migration.js --target-org <alias> [--ext-field <fieldApiName>]');
        process.exit(1);
    }
    opts.extField = opts.extField || 'External_Id__c';
    return opts;
}

const opts = parseArgs(process.argv.slice(2));
const workspaceRoot = path.resolve(__dirname, '..');
const trackingDir = path.join(workspaceRoot, '.git', 'sf-devops-dm', 'tracking');
const safeOrg = opts.targetOrg.replace(/[^a-zA-Z0-9_\-]/g, '_');
const trackingPath = path.join(trackingDir, `${safeOrg}.json`);

if (!fs.existsSync(trackingPath)) {
    console.error(`No tracking file found: ${trackingPath}`);
    process.exit(1);
}

const tracking = JSON.parse(fs.readFileSync(trackingPath, 'utf8'));
const objects = Object.keys(tracking);
if (objects.length === 0) {
    console.log('No tracking data found.');
    process.exit(0);
}

console.log(`\nValidating migration to: ${opts.targetOrg}`);
console.log(`ExternalId field: ${opts.extField}`);
console.log(`Tracking file: ${trackingPath}\n`);

const rows = [];
let hasDiscrepancy = false;

for (const sobject of objects) {
    const objTracking = tracking[sobject] || {};
    let created = 0, failed = 0, skipped = 0;
    for (const e of Object.values(objTracking)) {
        if (e.status === 'created') { created++; }
        else if (e.status === 'failed') { failed++; }
        else if (e.status === 'skipped') { skipped++; }
    }

    let targetCount = null;
    let error = null;
    try {
        const query = `SELECT COUNT() FROM ${sobject} WHERE ${opts.extField} != null`;
        const out = execFileSync('sf', ['data', 'query', '--query', query,
            '--target-org', opts.targetOrg, '--json'], { encoding: 'utf8', timeout: 30000 });
        targetCount = JSON.parse(out)?.result?.totalSize ?? null;
    } catch (e) {
        // Try to parse stdout from error object (sf CLI exits non-zero on API errors)
        try { targetCount = JSON.parse(e.stdout)?.result?.totalSize ?? null; } catch { /* ignore */ }
        if (targetCount === null) { error = (e.message || '').split('\n')[0].slice(0, 60); }
    }

    const match = targetCount !== null && targetCount === created;
    if (!match) { hasDiscrepancy = true; }
    rows.push({ sobject, created, failed, skipped, targetCount, match, error });
}

// Print table
const COL = 32;
const header = `${'Object'.padEnd(COL)}  ${'Tracking'.padStart(10)}  ${'Target'.padStart(10)}  Status`;
const sep = '─'.repeat(header.length);
console.log(header);
console.log(sep);
for (const r of rows) {
    const tgt = r.targetCount !== null ? String(r.targetCount) : (r.error ? 'ERR' : '?');
    const status = r.error ? `⚠ ${r.error}`
        : r.match ? '✓ match'
        : r.targetCount > r.created ? `+${r.targetCount - r.created} extra in target (not tracked)`
        : `${r.created - r.targetCount} missing from target`;
    console.log(`${r.sobject.padEnd(COL)}  ${String(r.created).padStart(10)}  ${tgt.padStart(10)}  ${status}`);
}
console.log(sep);

const matched = rows.filter(r => r.match).length;
console.log(`\nResult: ${matched}/${rows.length} objects matched`);
if (hasDiscrepancy) {
    console.log('⚠ Discrepancies found — run Reconcile in the VS Code panel to fix tracking.\n');
    process.exit(1);
} else {
    console.log('✓ All objects match.\n');
}
