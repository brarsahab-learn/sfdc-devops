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
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", isProd: false }];
config.canPromote = () => true;

const deployEngine = require("../out/DeploymentEngine.js");
let capturedSourceDirs = null;
deployEngine.runDeploy = async (workspaceRoot, sourceRoot, sourceDirs) => {
    capturedSourceDirs = sourceDirs;
    return { ran: true, success: true, numberComponentsDeployed: sourceDirs.length };
};

const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");

const panel = Object.create(DeploymentDashboardPanel.prototype);
panel._validatedSelections = new Map();
// Pre-seed the fingerprint lock so Deploy isn't blocked — set after we know the file set.
panel._lastOutcome = undefined;
panel._extContext = { globalState: { get: () => "Admin" } };
panel.refresh = async () => {};

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const env = { name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1", deployTestLevel: "RunLocalTests" };
    // Utils.cls is "pending" (selected), but its test class UtilsTest.cls is NOT among the
    // selected files — exactly the real-world shape that produced the bug report.
    const model = {
        env, groups: [], allFiles: [
            { path: "force-app/main/default/classes/Utils.cls", change: "modified" },
        ],
        apexTestMap: { Utils: "UtilsTest" },
        apexTestFilePaths: {
            UtilsTest: [
                "force-app/main/default/classes/UtilsTest.cls",
                "force-app/main/default/classes/UtilsTest.cls-meta.xml",
            ],
        },
        canDeploy: true, orgAliasSet: true,
    };
    panel._buildViewModel = async () => model;
    panel._gitHelper = {
        checkPrevEnvDeployed: async () => ({ blocked: false }),
            tryBeginOperation: () => true,
            endOperation: () => {},
        hasUncommittedChanges: async () => false,
        createLocalBranchFrom: async () => {},
        currentBranch: async () => "main",
        checkoutBranch: async () => {},
        remoteHeadSha: async () => null,
        appendAudit: async () => {},
        getWorkspaceRoot: () => "/tmp",
        remoteBranchExists: async () => false,
    };

    // First Validate the exact file selected (just Utils.cls) so Deploy isn't locked.
    await panel._runAction({
        env: "dev", actionMode: "validate", selectionMode: "files",
        files: ["force-app/main/default/classes/Utils.cls"], testMode: "auto",
    });
    check("validate ran with folded test files (3 total: Utils + UtilsTest.cls + meta)", capturedSourceDirs && capturedSourceDirs.length === 3, JSON.stringify(capturedSourceDirs));
    check("UtilsTest.cls itself is included in what's actually deployed", capturedSourceDirs && capturedSourceDirs.includes("force-app/main/default/classes/UtilsTest.cls"));
    check("UtilsTest.cls-meta.xml is included too", capturedSourceDirs && capturedSourceDirs.includes("force-app/main/default/classes/UtilsTest.cls-meta.xml"));

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
