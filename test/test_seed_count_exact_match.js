// countSeedRecords() previously matched seed filenames by substring (f.toLowerCase().includes(
// sobject.toLowerCase())), a leftover from the old multi-file `sf data export tree --plan`
// format. The redesign writes exactly one `{sobject}.json` file per object, so a substring match
// silently double-counts whenever one object's name is a substring of another's filename — e.g.
// "Account" also matches "AccountTeamMember.json". That inflates the Pull tab's per-object seed
// count and the Tracking tab's "Pulled" column, which is exactly the kind of thing that makes
// the stats look wrong. clearSeed had the same bug, and there it's worse: clearing "Account"'s
// seed data would also delete "AccountTeamMember.json".
const Module = require("module");
const path = require("path");
const os = require("os");
const fs = require("fs");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const dmConfig = require("../out/DataMigrationConfig.js");
const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), "dm-seedcount-"));
fs.writeFileSync(path.join(seedDir, "Account.json"), JSON.stringify({ records: [{ Id: "001a" }, { Id: "001b" }] }));
fs.writeFileSync(path.join(seedDir, "AccountTeamMember.json"), JSON.stringify({ records: [{ Id: "0Bxa" }, { Id: "0Bxb" }, { Id: "0Bxc" }] }));

dmConfig.readDmConfig = () => ({
    objects: [{ id: "a", sobject: "Account", active: true }, { id: "b", sobject: "AccountTeamMember", active: true }],
    seedDir, batchSize: 190,
});
dmConfig.getSourceOrg = () => "";
dmConfig.getTargetOrg = () => "myOrg";
dmConfig.readTracking = () => ({});
dmConfig.lastRunLogPath = () => "/tmp/does-not-exist";
dmConfig.pullLogsDir = () => "/tmp/does-not-exist";
dmConfig.loadLogsDir = () => "/tmp/does-not-exist";
dmConfig.listRecentLogs = () => [];

const roleMgr = require("../out/RoleManager.js");
roleMgr.getEffectiveRole = () => "Admin";
const cfg = require("../out/config.js");
cfg.getRoles = () => ["Dev", "Lead", "Admin"];
cfg.getEnvironments = () => ({});
cfg.getOrgAliasSlots = () => ({});

const { DataMigrationPanel } = require("../out/providers/DataMigrationPanel.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function makePanel() {
    const panel = Object.create(DataMigrationPanel.prototype);
    panel._workspaceRoot = "/tmp/fake-ws";
    panel._ctx = { globalState: { get: () => undefined } };
    panel._panel = { webview: { postMessage: () => {}, asWebviewUri: (u) => u, cspSource: "self" } };
    panel._config = dmConfig.readDmConfig();
    panel._activeTab = "migrate";
    panel._pullState = "idle";
    panel._loadState = "idle";
    panel._extBusy = false;
    panel._extBusyLabel = "";
    panel._lastError = null;
    panel._pullLog = [];
    panel._loadLog = [];
    panel._trackingViewOrg = "myOrg";
    panel._availableOrgs = [];
    panel._dryRunMode = false;
    panel._trackingCache = undefined;
    return panel;
}

// ---- 1. Seed counts don't bleed across objects whose names overlap as substrings ----
{
    const vm = makePanel()._buildViewModel();
    const account = vm.seedInfo.find(s => s.sobject === "Account");
    const teamMember = vm.seedInfo.find(s => s.sobject === "AccountTeamMember");
    check("Account shows only its own 2 records, not 5", account.count === 2, account.count);
    check("AccountTeamMember shows only its own 3 records", teamMember.count === 3, teamMember.count);
}

console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
fs.rmSync(seedDir, { recursive: true, force: true });
process.exit(allPass ? 0 : 1);
