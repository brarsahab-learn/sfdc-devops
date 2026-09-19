#!/usr/bin/env node
/**
 * Creates System Administrator Users in a target org from
 * system-admin-users.json - an editable list of { email } entries (add more
 * by just appending to that file).
 *
 * Per-user fields are derived, not stored, so the config stays minimal:
 *   - FirstName : the email's local-part (before @), title-cased
 *   - LastName  : "defaults.lastName" in system-admin-users.json
 *   - Username  : <firstname-lowercased>@ib.<org-code>  (org code is
 *                 arbitrary per org, e.g. PP01/PP02 - passed explicitly,
 *                 there's no reliable way to derive it)
 *   - Alias     : first 8 chars of FirstName
 *   - Profile   : "defaults.profileName" in system-admin-users.json,
 *                 resolved to a real Profile Id in the target org
 *
 * Idempotent: skips any user whose derived Username already exists in the
 * target org. Newly created users are set Active immediately and get a
 * welcome/password-reset email via System.resetPassword (the standard way
 * to trigger that email for API-created users, since a plain insert does
 * not send one on its own).
 *
 * Usage:
 *   node data-migration/load-admin-users.js --target-org <org> --org-code <code> [--user <email|all>]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const CONFIG_PATH = path.join(__dirname, 'system-admin-users.json');

function parseArgs(argv) {
    const opts = { user: 'all' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--target-org' || a === '-o') opts.targetOrg = argv[++i];
        else if (a === '--org-code') opts.orgCode = argv[++i];
        else if (a === '--user') opts.user = argv[++i];
        else {
            console.error(`Unknown argument: ${a}`);
            process.exit(1);
        }
    }
    return opts;
}

function titleCase(s) {
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function deriveUser(entry, defaults, orgCode) {
    const localPart = entry.email.split('@')[0];
    const firstName = titleCase(localPart);
    return {
        email: entry.email,
        firstName,
        lastName: entry.lastName || defaults.lastName,
        alias: firstName.slice(0, 8),
        username: `${firstName.toLowerCase()}@ib.${orgCode.toLowerCase()}`,
        profileName: entry.profileName || defaults.profileName,
        timeZoneSidKey: defaults.timeZoneSidKey,
        localeSidKey: defaults.localeSidKey,
        emailEncodingKey: defaults.emailEncodingKey,
        languageLocaleKey: defaults.languageLocaleKey,
    };
}

function escapeApexString(s) {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildApex(users) {
    const userLiterals = users.map((u) => `
        new Map<String, String>{
            'username' => '${escapeApexString(u.username)}',
            'email' => '${escapeApexString(u.email)}',
            'firstName' => '${escapeApexString(u.firstName)}',
            'lastName' => '${escapeApexString(u.lastName)}',
            'alias' => '${escapeApexString(u.alias)}',
            'profileName' => '${escapeApexString(u.profileName)}',
            'timeZoneSidKey' => '${escapeApexString(u.timeZoneSidKey)}',
            'localeSidKey' => '${escapeApexString(u.localeSidKey)}',
            'emailEncodingKey' => '${escapeApexString(u.emailEncodingKey)}',
            'languageLocaleKey' => '${escapeApexString(u.languageLocaleKey)}'
        }`).join(',');

    return `
List<Map<String, String>> userDefs = new List<Map<String, String>>{${userLiterals}
};

Map<String, Id> profileIdByName = new Map<String, Id>();
for (Profile p : [SELECT Id, Name FROM Profile]) {
    profileIdByName.put(p.Name, p.Id);
}

Set<String> usernames = new Set<String>();
for (Map<String, String> u : userDefs) usernames.add(u.get('username'));
Set<String> existingUsernames = new Set<String>();
for (User existing : [SELECT Username FROM User WHERE Username IN :usernames]) {
    existingUsernames.add(existing.Username);
}

Integer created = 0, skipped = 0, failed = 0;
for (Map<String, String> u : userDefs) {
    String username = u.get('username');
    if (existingUsernames.contains(username)) {
        System.debug('SKIP (already exists): ' + username);
        skipped++;
        continue;
    }
    Id profileId = profileIdByName.get(u.get('profileName'));
    if (profileId == null) {
        System.debug('FAIL: ' + username + ' - no Profile named "' + u.get('profileName') + '" in this org');
        failed++;
        continue;
    }
    User newUser = new User(
        Username = username,
        Email = u.get('email'),
        FirstName = u.get('firstName'),
        LastName = u.get('lastName'),
        Alias = u.get('alias'),
        ProfileId = profileId,
        TimeZoneSidKey = u.get('timeZoneSidKey'),
        LocaleSidKey = u.get('localeSidKey'),
        EmailEncodingKey = u.get('emailEncodingKey'),
        LanguageLocaleKey = u.get('languageLocaleKey'),
        IsActive = true
    );
    try {
        insert newUser;
        created++;
        System.debug('CREATED: ' + username + ' (' + newUser.Id + ')');
        try {
            System.resetPassword(newUser.Id, true);
            System.debug('  welcome/reset email sent to ' + u.get('email'));
        } catch (Exception resetEx) {
            System.debug('  WARNING: user created but welcome email failed to send: ' + resetEx.getMessage());
        }
    } catch (Exception e) {
        failed++;
        System.debug('FAIL: ' + username + ' - ' + e.getMessage());
    }
}

System.debug('=== Admin user load summary: created=' + created + ' skipped=' + skipped + ' failed=' + failed + ' of total=' + userDefs.size() + ' ===');
`;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.targetOrg || !opts.orgCode) {
        console.error('Usage: node data-migration/load-admin-users.js --target-org <org> --org-code <code> [--user <email|all>]');
        process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    let entries = config.users;
    if (opts.user !== 'all') {
        entries = entries.filter((e) => e.email.toLowerCase() === opts.user.toLowerCase());
        if (entries.length === 0) {
            console.error(`No user with email '${opts.user}' found in ${CONFIG_PATH}.`);
            console.error(`Known emails: ${config.users.map((e) => e.email).join(', ')}`);
            process.exit(1);
        }
    }

    const users = entries.map((e) => deriveUser(e, config.defaults, opts.orgCode));

    console.log(`==> Users to load into '${opts.targetOrg}' (org code '${opts.orgCode}'):`);
    for (const u of users) {
        console.log(`    ${u.username}  (${u.firstName} ${u.lastName}, ${u.profileName}, email=${u.email})`);
    }

    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'load-admin-users-')), 'create-users.apex');
    fs.writeFileSync(tmpFile, buildApex(users));

    console.log(`\n[running] apex user creation in '${opts.targetOrg}'`);
    try {
        execFileSync('sf', ['apex', 'run', '--file', tmpFile, '--target-org', opts.targetOrg], { stdio: 'inherit' });
    } finally {
        fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true });
    }
}

main();
