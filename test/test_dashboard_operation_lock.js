const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let lastWarningMsg = null;
fakeVscode.window.showWarningMessage = async (msg) => { lastWarningMsg = msg; return "Yes, deploy"; };
fakeVscode.window.showInformationMessage = async () => undefined;
fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
fakeVscode.ProgressLocation = { Notification: 1 };

const config = require("../out/config.js");
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1" });
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", isProd: false, orgAlias: "QA-LIVE" }];
config.canPromote = () => true;

const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. A second click on the SAME env while one is still running is refused, not raced ----
    {
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        panel._lastOutcome = undefined;
        panel._extContext = { globalState: { get: () => "Admin" } };
        panel.refresh = async () => {};
        const env = { name: "qa", label: "QA", branch: "qa", isProd: false, orgAlias: "QA-LIVE", deployTestLevel: "NoTestRun" };
        const model = {
            env, groups: [], apexTestMap: {}, apexTestFilePaths: {}, canDeploy: true, orgAliasSet: true,
            allFiles: [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
        };
        panel._buildViewModel = async () => model;

        let checkoutCalls = 0;
        const inFlight = new Set();
        panel._gitHelper = {
            tryBeginOperation: (key) => { if (inFlight.has(key)) { return false; } inFlight.add(key); return true; },
            endOperation: (key) => { inFlight.delete(key); },
            checkPrevEnvDeployed: async () => ({ blocked: false }),
            hasUncommittedChanges: async () => false,
            createLocalBranchFrom: async () => { checkoutCalls++; await new Promise(r => setTimeout(r, 30)); },
            currentBranch: async () => "main",
            checkoutBranch: async () => {},
            remoteHeadSha: async () => null,
            appendAudit: async () => {},
            getWorkspaceRoot: () => "/tmp",
        };

        lastWarningMsg = null;
        const first = panel._runAction({
            env: "qa", actionMode: "validate", selectionMode: "files",
            files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto",
        });
        await new Promise(r => setTimeout(r, 5)); // fire the second click mid-flight
        await panel._runAction({
            env: "qa", actionMode: "deploy", selectionMode: "files",
            files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto",
        });
        check("second click refused with a clear message", lastWarningMsg && lastWarningMsg.includes("Already") && lastWarningMsg.includes("give it a moment"), lastWarningMsg);
        check("only one checkout actually happened (no race)", checkoutCalls === 1, checkoutCalls);
        await first;
        check("lock is released once the first action finishes", !inFlight.has("dashboard:qa"));
    }

    // ---- 2. Two DIFFERENT envs are independent — one doesn't block the other ----
    {
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        panel._extContext = { globalState: { get: () => "Admin" } };
        panel.refresh = async () => {};
        panel._buildViewModel = async (env) => ({
            env, groups: [], apexTestMap: {}, apexTestFilePaths: {}, canDeploy: true, orgAliasSet: true,
            allFiles: [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
        });
        const inFlight = new Set();
        panel._gitHelper = {
            tryBeginOperation: (key) => { if (inFlight.has(key)) { return false; } inFlight.add(key); return true; },
            endOperation: (key) => { inFlight.delete(key); },
            checkPrevEnvDeployed: async () => ({ blocked: false }),
            hasUncommittedChanges: async () => false,
            createLocalBranchFrom: async () => {},
            currentBranch: async () => "main",
            checkoutBranch: async () => {},
            remoteHeadSha: async () => null,
            appendAudit: async () => {},
            getWorkspaceRoot: () => "/tmp",
        };

        lastWarningMsg = null;
        await panel._runAction({ env: "dev", actionMode: "validate", selectionMode: "files", files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto" });
        const warnAfterDev = lastWarningMsg;
        lastWarningMsg = null;
        await panel._runAction({ env: "qa", actionMode: "validate", selectionMode: "files", files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto" });
        check("validating a different env isn't blocked by dev's lock", !(lastWarningMsg && lastWarningMsg.includes("Already")), lastWarningMsg);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
