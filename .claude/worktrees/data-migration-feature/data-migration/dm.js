#!/usr/bin/env node
/**
 * Master data-migration (DM) control script - single entry point over
 * pull-seed-data.js / load-seed-data.js.
 *
 * Interactive menu (just run it, no args):
 *   node data-migration/dm.js
 *
 * Or drive it directly for scripting/CI:
 *   node data-migration/dm.js pull   --source-org <org>
 *   node data-migration/dm.js load   --target-org <org> [--object <Name|all>]
 *   node data-migration/dm.js clear  --target-org <org> [--object <Name|all>]
 *   node data-migration/dm.js reset  --target-org <org> [--object <Name|all>]
 *   node data-migration/dm.js status --target-org <org>
 *
 * Add --yes to skip the confirmation prompt on destructive operations
 * (clear/reset/pull) when driving it non-interactively.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { execFileSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const PLAN_PATH = path.join(SCRIPTS_DIR, 'seed', 'plan.json');
const ADMIN_USERS_PATH = path.join(SCRIPTS_DIR, 'system-admin-users.json');

// ---------------------------------------------------------------
// Output formatting - every operation gets a clear header, an explicit
// summary of what was selected before anything runs, and a clear
// success/failure footer once it's done.
// ---------------------------------------------------------------

const RULE = '='.repeat(60);
const SUBRULE = '-'.repeat(60);

function printTitle(title) {
    console.log(`\n${RULE}`);
    console.log(`  ${title}`);
    console.log(RULE);
}

function printSection(title) {
    console.log(`\n${SUBRULE}`);
    console.log(`  ${title}`);
    console.log(SUBRULE);
}

/** Prints an aligned "Label : value" block summarizing every selection made so far. */
function printSummary(fields) {
    const labelWidth = Math.max(...Object.keys(fields).map((k) => k.length));
    console.log('\nSummary:');
    for (const [k, v] of Object.entries(fields)) {
        console.log(`  ${k.padEnd(labelWidth)} : ${v}`);
    }
    console.log('');
}

function printOutcome(ok, label) {
    console.log(`\n${SUBRULE}`);
    console.log(ok ? `  DONE: ${label}` : `  FAILED: ${label}`);
    console.log(SUBRULE);
}

function loadObjectNames() {
    if (!fs.existsSync(PLAN_PATH)) return [];
    return JSON.parse(fs.readFileSync(PLAN_PATH, 'utf8')).map((e) => e.sobject);
}

function listOrgs() {
    try {
        const out = execFileSync('sf', ['org', 'list', '--json'], { encoding: 'utf8' });
        const result = JSON.parse(out).result;
        const groups = ['nonScratchOrgs', 'sandboxes', 'scratchOrgs', 'devHubs', 'other'];
        const seen = new Map();
        for (const g of groups) {
            for (const o of result[g] || []) {
                const key = o.username;
                if (!seen.has(key)) {
                    seen.set(key, { alias: o.alias || '', username: o.username, isScratch: !!o.isScratch, isSandbox: !!o.isSandbox });
                }
            }
        }
        return [...seen.values()];
    } catch (e) {
        return [];
    }
}

function run(scriptName, args, { allowFailure = false, step } = {}) {
    console.log(`\n[running] node data-migration/${scriptName} ${args.join(' ')}`);
    if (step) console.log(`          (${step})`);
    console.log('');
    try {
        execFileSync('node', [path.join(SCRIPTS_DIR, scriptName), ...args], { stdio: 'inherit' });
        return true;
    } catch (e) {
        if (!allowFailure) {
            console.error(`\n'${scriptName}' exited with an error (see output above).`);
        }
        return false;
    }
}

/**
 * Sets the Insurer/Insurer-Contact record types. Must run AFTER Account is
 * loaded (it retypes the just-created Accounts) but BEFORE anything with a
 * lookup filter that requires that record type - Product_Insurer_Mapping__c
 * and Broker_Office_Location__c both filter their Account lookup on
 * RecordType, so inserting them while Account is still untyped fails every
 * record. Safe to call again later too (e.g. once Contacts exist) - it only
 * touches records that don't already have the right type.
 */
function runInsurerRecordTypeFixup(targetOrg) {
    const fixupApex = path.join(SCRIPTS_DIR, 'apex', 'fix-insurer-record-types.apex');
    console.log(`\n[running] Insurer Account/Contact record-type fixup in '${targetOrg}'`);
    try {
        execFileSync('sf', ['apex', 'run', '--file', fixupApex, '--target-org', targetOrg], { stdio: 'inherit' });
    } catch (e) {
        console.error('WARNING: fix-insurer-record-types.apex failed - check output above.');
    }
}

function runLocationSeeding(targetOrg) {
    const locationsApex = path.join(SCRIPTS_DIR, 'apex', 'seed-locations.apex');
    console.log(`\n[running] Sample Location seeding in '${targetOrg}'`);
    try {
        execFileSync('sf', ['apex', 'run', '--file', locationsApex, '--target-org', targetOrg], { stdio: 'inherit' });
    } catch (e) {
        console.error('WARNING: seed-locations.apex failed - check output above.');
    }
}

/**
 * Runs a load in two passes so the record-type fixup can land between them:
 *   1) load-seed-data.js scoped to Account (auto-cascades its prerequisites:
 *      Product_Group__c, Team__c, Product__c, Component_Master__c, Broker__c)
 *   2) fix Insurer record types on the Accounts just created
 *   3) load-seed-data.js scoped to whatever the caller actually asked for
 *      (already-created records are skipped, so re-running pass 1's objects
 *      here is a cheap no-op)
 *   4) fix record types again, now that Contacts exist too
 *   5) sample-location seeding
 * If the caller's requested object is at/before Account in dependency order,
 * pass 3 is just a no-op repeat of pass 1 - harmless, not worth special-casing.
 */
function runPhasedLoad(targetOrg, object, extraLoadArgs = []) {
    const passOneOk = run('load-seed-data.js', ['--target-org', targetOrg, '--object', 'Account']);
    if (!passOneOk) return false;
    runInsurerRecordTypeFixup(targetOrg);
    const passTwoOk = run('load-seed-data.js', ['--target-org', targetOrg, '--object', object, ...extraLoadArgs]);
    runInsurerRecordTypeFixup(targetOrg);
    runLocationSeeding(targetOrg);
    return passTwoOk;
}

// ---------------------------------------------------------------
// Non-interactive (flag-driven) mode
// ---------------------------------------------------------------

function parseFlags(argv) {
    const opts = { object: 'all', user: 'all', yes: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--target-org' || a === '-o') opts.targetOrg = argv[++i];
        else if (a === '--source-org') opts.sourceOrg = argv[++i];
        else if (a === '--object') opts.object = argv[++i];
        else if (a === '--org-code') opts.orgCode = argv[++i];
        else if (a === '--user') opts.user = argv[++i];
        else if (a === '--yes' || a === '-y') opts.yes = true;
        else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    return opts;
}

async function confirm(question, skipPrompt) {
    if (skipPrompt) return true;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`${question} [y/N] `);
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
}

const COMMAND_TITLES = {
    pull: 'Pull / refresh seed data',
    load: 'Load data',
    clear: 'Clear loaded data',
    reset: 'Reset (clear + reload)',
    status: 'Load status',
    users: 'Load System Admin Users',
};

async function runNonInteractive(command, argv) {
    const KNOWN_COMMANDS = ['pull', 'load', 'clear', 'reset', 'status', 'users'];
    if (!KNOWN_COMMANDS.includes(command)) {
        console.error(`Unknown command: ${command}`);
        console.error('Usage: dm.js <pull|load|clear|reset|status|users> [options]');
        process.exit(1);
    }

    const opts = parseFlags(argv);
    printTitle(`Operation: ${COMMAND_TITLES[command]}`);

    if (command === 'pull') {
        if (!opts.sourceOrg) { console.error('Usage: dm.js pull --source-org <org> [--yes]'); process.exit(1); }
        printSummary({ Operation: COMMAND_TITLES.pull, 'Source org': opts.sourceOrg, Objects: 'per pull-objects.json' });
        const ok = await confirm(
            `This overwrites seed/ from '${opts.sourceOrg}' (per pull-objects.json) and clears all per-org load tracking. Continue?`,
            opts.yes
        );
        if (!ok) { console.log('Aborted.'); return; }
        const success = run('pull-seed-data.js', [opts.sourceOrg]);
        printOutcome(success, COMMAND_TITLES.pull);
        return;
    }

    if (!opts.targetOrg) { console.error(`Usage: dm.js ${command} --target-org <org> [--object <Name|all>] [--yes]`); process.exit(1); }

    if (command === 'status') {
        printSummary({ Operation: COMMAND_TITLES.status, Org: opts.targetOrg });
        run('load-seed-data.js', ['--target-org', opts.targetOrg, '--status']);
        return;
    }

    if (command === 'load') {
        printSummary({ Operation: COMMAND_TITLES.load, Org: opts.targetOrg, Object: opts.object });
        const ok = runPhasedLoad(opts.targetOrg, opts.object);
        printOutcome(ok, COMMAND_TITLES.load);
        return;
    }

    if (command === 'clear') {
        printSummary({
            Operation: COMMAND_TITLES.clear,
            Org: opts.targetOrg,
            Object: `${opts.object} (and everything after it in dependency order)`,
        });
        const ok = await confirm('This will permanently delete the records above. Continue?', opts.yes);
        if (!ok) { console.log('Aborted.'); return; }
        const success = run('load-seed-data.js', ['--target-org', opts.targetOrg, '--object', opts.object, '--clear']);
        printOutcome(success, COMMAND_TITLES.clear);
        return;
    }

    if (command === 'reset') {
        printSummary({
            Operation: COMMAND_TITLES.reset,
            Org: opts.targetOrg,
            Object: `${opts.object} (and everything after it in dependency order)`,
        });
        const ok = await confirm('This will delete and reload the records above. Continue?', opts.yes);
        if (!ok) { console.log('Aborted.'); return; }
        const cleared = run('load-seed-data.js', ['--target-org', opts.targetOrg, '--object', opts.object, '--clear']);
        const success = cleared && runPhasedLoad(opts.targetOrg, opts.object);
        printOutcome(success, COMMAND_TITLES.reset);
        return;
    }

    if (command === 'users') {
        if (!opts.orgCode) { console.error('Usage: dm.js users --target-org <org> --org-code <code> [--user <email|all>] [--yes]'); process.exit(1); }
        printSummary({ Operation: COMMAND_TITLES.users, Org: opts.targetOrg, 'Org code': opts.orgCode, User: opts.user });
        const ok = await confirm(
            'This creates real Salesforce Users (consumes license seats) and sends a welcome/password-reset email to each. Continue?',
            opts.yes
        );
        if (!ok) { console.log('Aborted.'); return; }
        const success = run('load-admin-users.js', ['--target-org', opts.targetOrg, '--org-code', opts.orgCode, '--user', opts.user]);
        printOutcome(success, COMMAND_TITLES.users);
    }
}

// ---------------------------------------------------------------
// Interactive menu mode
// ---------------------------------------------------------------

async function pickFromList(rl, label, options, { allowCustom = true } = {}) {
    console.log(`\n${label}`);
    options.forEach((o, i) => console.log(`  ${i + 1}) ${o.display}`));
    if (allowCustom) console.log(`  ${options.length + 1}) Enter manually`);
    const answer = await rl.question('\nAction> ');
    const idx = parseInt(answer.trim(), 10);
    if (idx >= 1 && idx <= options.length) return options[idx - 1].value;
    if (allowCustom && idx === options.length + 1) {
        return (await rl.question('Org alias/username: ')).trim();
    }
    return null;
}

async function pickOrg(rl, label) {
    const orgs = listOrgs();
    const options = orgs.map((o) => ({
        display: `${o.alias || '(no alias)'} — ${o.username}${o.isScratch ? ' [scratch]' : o.isSandbox ? ' [sandbox]' : ''}`,
        value: o.alias || o.username,
    }));
    const choice = await pickFromList(rl, label, options);
    if (!choice) console.log('No valid selection.');
    return choice;
}

/**
 * Wraps pickOrg() with session memory: once an org has been picked, later
 * operations offer "0) Keep using '<org>'" instead of forcing a fresh pick
 * every time. Explicitly asks whether to change org or proceed with the
 * preselected one.
 */
async function pickOrgRemembered(rl, label, state) {
    if (state.lastOrg) {
        console.log(`\n${label}`);
        console.log(`  0) Keep using '${state.lastOrg}'`);
        console.log(`  1) Choose a different org`);
        const answer = (await rl.question('\nAction> ')).trim();
        if (answer === '' || answer === '0') {
            return state.lastOrg;
        }
        // Anything else (including '1') falls through to a fresh pick below.
    }
    const org = await pickOrg(rl, label);
    if (org) state.lastOrg = org;
    return org;
}

async function pickObject(rl) {
    const names = loadObjectNames();
    if (names.length === 0) {
        console.log('No seed/plan.json found - defaulting to "all".');
        return 'all';
    }
    const options = [{ display: 'All objects', value: 'all' }, ...names.map((n) => ({ display: n, value: n }))];
    const choice = await pickFromList(rl, 'Which object?', options, { allowCustom: false });
    return choice || 'all';
}

async function pickAdminUser(rl) {
    if (!fs.existsSync(ADMIN_USERS_PATH)) {
        console.log('No system-admin-users.json found - defaulting to "all".');
        return 'all';
    }
    const config = JSON.parse(fs.readFileSync(ADMIN_USERS_PATH, 'utf8'));
    const options = [
        { display: 'All users', value: 'all' },
        ...config.users.map((u) => ({ display: u.email, value: u.email })),
    ];
    const choice = await pickFromList(rl, 'Which user?', options, { allowCustom: false });
    return choice || 'all';
}

const MENU_OPTIONS = [
    { key: '1', label: 'Load data into a target org' },
    { key: '2', label: 'Show load status for a target org' },
    { key: '3', label: 'Clear loaded data (no reload)' },
    { key: '4', label: 'Reset (clear + reload)' },
    { key: '5', label: 'Pull / refresh seed data from a source org' },
    { key: '6', label: 'Load System Admin Users into a target org' },
    { key: '7', label: 'Exit' },
];

async function interactiveMenu() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const orgState = { lastOrg: null };
    try {
        for (;;) {
            printTitle('DM Control — data-migration');
            console.log('Select an operation:');
            for (const o of MENU_OPTIONS) console.log(`  ${o.key}) ${o.label}`);
            const choice = (await rl.question('\nAction> ')).trim();

            if (choice === '7' || choice.toLowerCase() === 'exit') break;

            if (choice === '1') {
                printSection(COMMAND_TITLES.load);
                const targetOrg = await pickOrgRemembered(rl, 'Load into which org?', orgState);
                if (!targetOrg) continue;
                const object = await pickObject(rl);
                printSummary({ Operation: COMMAND_TITLES.load, Org: targetOrg, Object: object });
                const ok = runPhasedLoad(targetOrg, object);
                printOutcome(ok, COMMAND_TITLES.load);
                continue;
            }

            if (choice === '2') {
                printSection(COMMAND_TITLES.status);
                const targetOrg = await pickOrgRemembered(rl, 'Show status for which org?', orgState);
                if (!targetOrg) continue;
                printSummary({ Operation: COMMAND_TITLES.status, Org: targetOrg });
                run('load-seed-data.js', ['--target-org', targetOrg, '--status']);
                continue;
            }

            if (choice === '3' || choice === '4') {
                const isReset = choice === '4';
                const title = isReset ? COMMAND_TITLES.reset : COMMAND_TITLES.clear;
                printSection(title);
                const targetOrg = await pickOrgRemembered(rl, `${isReset ? 'Reset' : 'Clear'} which org?`, orgState);
                if (!targetOrg) continue;
                const object = await pickObject(rl);
                printSummary({
                    Operation: title,
                    Org: targetOrg,
                    Object: `${object} (and everything after it in dependency order)`,
                });
                const verb = isReset ? 'delete and reload' : 'permanently delete';
                const sure = await rl.question(`This will ${verb} the records above. Type YES to confirm: `);
                if (sure.trim() !== 'YES') { console.log('Aborted.'); continue; }
                const cleared = run('load-seed-data.js', ['--target-org', targetOrg, '--object', object, '--clear']);
                const ok = isReset ? (cleared && runPhasedLoad(targetOrg, object)) : cleared;
                printOutcome(ok, title);
                continue;
            }

            if (choice === '5') {
                printSection(COMMAND_TITLES.pull);
                console.log('Which objects get pulled is controlled by data-migration/pull-objects.json.');
                console.log('Edit that file (add/remove/reorder { sobject, query } entries) to change what gets captured, then come back here.');
                const sourceOrg = await pickOrgRemembered(rl, 'Pull seed data from which org?', orgState);
                if (!sourceOrg) continue;
                printSummary({ Operation: COMMAND_TITLES.pull, 'Source org': sourceOrg, Objects: 'per pull-objects.json' });
                const sure = await rl.question(
                    `This overwrites seed/ from '${sourceOrg}' and clears all per-org load tracking. Type YES to confirm: `
                );
                if (sure.trim() !== 'YES') { console.log('Aborted.'); continue; }
                const ok = run('pull-seed-data.js', [sourceOrg]);
                printOutcome(ok, COMMAND_TITLES.pull);
                continue;
            }

            if (choice === '6') {
                printSection(COMMAND_TITLES.users);
                console.log('Users are defined in data-migration/system-admin-users.json - edit that file to add/remove people.');
                const targetOrg = await pickOrgRemembered(rl, 'Load admin users into which org?', orgState);
                if (!targetOrg) continue;
                const orgCode = (await rl.question("Org code for this org (used in the username, e.g. 'PP01'): ")).trim();
                if (!orgCode) { console.log('No org code entered - aborted.'); continue; }
                const user = await pickAdminUser(rl);
                printSummary({ Operation: COMMAND_TITLES.users, Org: targetOrg, 'Org code': orgCode, User: user });
                const sure = await rl.question(
                    'This creates real Salesforce Users (consumes license seats) and sends a welcome/password-reset email to each. Type YES to confirm: '
                );
                if (sure.trim() !== 'YES') { console.log('Aborted.'); continue; }
                const ok = run('load-admin-users.js', ['--target-org', targetOrg, '--org-code', orgCode, '--user', user]);
                printOutcome(ok, COMMAND_TITLES.users);
                continue;
            }

            console.log('Unrecognized choice. Pick a number from the menu above.');
        }
    } finally {
        rl.close();
    }
}

async function main() {
    const argv = process.argv.slice(2);
    if (argv.length === 0) {
        await interactiveMenu();
        return;
    }
    await runNonInteractive(argv[0], argv.slice(1));
}

main();
