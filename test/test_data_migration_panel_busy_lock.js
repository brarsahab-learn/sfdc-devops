// Guards the busy-lock behavior added to DataMigrationPanel: an ExternalId check/create/auto-sort
// operation must refuse to overlap another one already in flight, and a failure must surface via
// showErrorMessage AND stick in the panel's persistent _lastError banner (not just a one-shot
// postMessage that a later refresh would silently wipe).
const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));

let warnings = [];
let errors = [];
fakeVscode.window.showWarningMessage = async (msg) => { warnings.push(msg); return undefined; };
fakeVscode.window.showErrorMessage = async (msg) => { errors.push(msg); return undefined; };

const dmConfig = require("../out/DataMigrationConfig.js");
dmConfig.readDmConfig = () => ({
    objects: [{ id: "a", sobject: "Broker__c", active: true, externalIdVerified: false }],
    autoCreateExternalId: true, batchSize: 190, seedDir: ".git/sf-devops-dm/seed",
});
dmConfig.writeDmConfig = () => {};

const dmEngine = require("../out/DataMigrationEngine.js");
let resolveCheck;
dmEngine.checkExternalId = () => new Promise((resolve) => { resolveCheck = resolve; });
let createExtIdCalls = 0;
dmEngine.createExternalIdField = async () => { createExtIdCalls++; return "External_Id__c"; };

const { DataMigrationPanel } = require("../out/providers/DataMigrationPanel.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function makePanel() {
    const panel = Object.create(DataMigrationPanel.prototype);
    panel._workspaceRoot = "/tmp/fake-ws";
    panel._ctx = {};
    panel._panel = { webview: { postMessage: () => {} } };
    panel._config = dmConfig.readDmConfig();
    panel._activeTab = "extids";
    panel._pullState = "idle";
    panel._loadState = "idle";
    panel._extBusy = false;
    panel._extBusyLabel = "";
    panel._lastError = null;
    panel._pullLog = [];
    panel._loadLog = [];
    panel._trackingViewOrg = "";
    panel._availableOrgs = [];
    panel._dryRunMode = false;
    panel._refresh = () => {}; // no full HTML render needed for these assertions
    return panel;
}

(async () => {
    // ---- 1. A second ExternalId operation started while one is still running is refused ----
    {
        const panel = makePanel();
        const first = panel._handleCheckExtId("Broker__c", "myOrg"); // hangs until resolveCheck() fires
        await new Promise((r) => setTimeout(r, 5));

        check("first check is marked busy", panel._extBusy === true);
        check("_anyRunning reflects the in-flight check", panel._anyRunning === true);

        warnings = [];
        await panel._handleCreateExtId("Broker__c", "myOrg"); // should bail immediately, not call createExternalIdField
        check("overlapping op is refused with a warning", warnings.length === 1, JSON.stringify(warnings));
        check("the refused op never actually ran", createExtIdCalls === 0);

        resolveCheck(null); // let the first op finish
        await first;
        check("busy clears once the first op completes", panel._extBusy === false);
    }

    // ---- 2. A failure surfaces via showErrorMessage AND persists in _lastError ----
    {
        const panel = makePanel();
        dmEngine.checkExternalId = async () => { throw new Error("ENOENT: sf not found"); };

        errors = [];
        await panel._handleCheckExtId("Broker__c", "myOrg");
        check("failure shows a native error notification", errors.length === 1 && errors[0].includes("ENOENT"), JSON.stringify(errors));
        check("failure is recorded in the persistent _lastError banner", panel._lastError && panel._lastError.includes("ENOENT"), panel._lastError);
        check("busy clears after the failure too", panel._extBusy === false);
    }

    // ---- 3. Starting a new op clears a stale previous error ----
    {
        const panel = makePanel();
        panel._lastError = "stale error from a previous run";
        dmEngine.checkExternalId = () => new Promise((resolve) => { resolveCheck = resolve; });

        const run = panel._handleCheckExtId("Broker__c", "myOrg");
        await new Promise((r) => setTimeout(r, 5));
        check("a new run clears the stale error immediately", panel._lastError === null);
        resolveCheck(null);
        await run;
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
