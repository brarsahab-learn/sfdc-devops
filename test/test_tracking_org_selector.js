// The Tracking tab's "Viewing org" dropdown was built from targetOrg + trackedOrgs (orgs that
// already have a tracking file) + pipeline env orgs — but never from `availableOrgs`, the list
// the "⚙️ Orgs" button refreshes. So clicking "⚙️ Orgs" fetched a fresh org list into memory, but
// the dropdown never used it: any connected org that wasn't already a pipeline env or one that
// had already been loaded into was simply impossible to select, no matter how many times you
// clicked refresh. That's why refreshing looked like it "did nothing" — the button worked, its
// result was just never wired into the UI it's sitting next to.
const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const dmConfig = require("../out/DataMigrationConfig.js");
dmConfig.readDmConfig = () => ({ objects: [], seedDir: ".git/sf-devops-dm/seed", batchSize: 190 });
dmConfig.getSourceOrg = () => "";
dmConfig.getTargetOrg = () => "currentTarget";
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

const panel = Object.create(DataMigrationPanel.prototype);
panel._workspaceRoot = "/tmp/fake-ws";
panel._ctx = { globalState: { get: () => undefined } };
panel._panel = { webview: { postMessage: () => {}, asWebviewUri: (u) => u, cspSource: "self" } };
panel._config = dmConfig.readDmConfig();
panel._activeTab = "tracking";
panel._pullState = "idle";
panel._loadState = "idle";
panel._extBusy = false;
panel._extBusyLabel = "";
panel._lastError = null;
panel._pullLog = [];
panel._loadLog = [];
panel._trackingViewOrg = "";
// Simulates having just clicked "⚙️ Orgs" and it discovering an org that isn't a pipeline env
// and has no tracking file yet.
panel._availableOrgs = [
    { alias: "insurebridge-live", username: "hardeep@ib.live" },
    { alias: "insurebridge-live--qa", username: "hardeep@ib.live.qa" },
];
panel._dryRunMode = false;
panel._trackingCache = undefined;

const vm = panel._buildViewModel();
const html = panel._renderHtml(vm);

check("a connected org discovered via refresh is selectable in the Viewing-org dropdown", html.includes(">insurebridge-live<"));
check("a second discovered org is also selectable", html.includes(">insurebridge-live--qa<"));

console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
process.exit(allPass ? 0 : 1);
