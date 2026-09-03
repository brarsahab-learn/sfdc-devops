const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let warnings = [];
fakeVscode.window.showWarningMessage = async (msg) => { warnings.push(msg); return undefined; };
fakeVscode.ProgressLocation = { Notification: 1 };
fakeVscode.window.withProgress = async (opts, task) => task();

const config = require("../out/config.js");
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev", isProd: false });
config.getPromotableEnvironments = () => [
    { name: "qa", label: "QA", branch: "qa", isProd: false, requiredRole: undefined, orgAlias: "" },
    { name: "uat", label: "UAT", branch: "uat", isProd: false, orgAlias: "" },
];
config.canPromote = () => true;

const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");

const panel = Object.create(DeploymentDashboardPanel.prototype);
panel._validatedSelections = new Map();
panel._lastOutcome = undefined;
panel._extContext = { globalState: { get: () => "Admin" } };

let gateChecked = [];
panel._gitHelper = {
    checkPrevEnvDeployed: async (prevEnv) => { gateChecked.push(prevEnv.name); return { blocked: false }; },
    tryBeginOperation: () => true,
    endOperation: () => {},
    hasUncommittedChanges: async () => false,
    createLocalBranchFrom: async () => {},
    currentBranch: async () => "main",
    checkoutBranch: async () => {},
    remoteHeadSha: async () => null,
    appendAudit: async () => {},
    getWorkspaceRoot: () => "/tmp",
};
panel.refresh = async () => {};
panel._buildViewModel = async (env) => ({
    env, groups: [], allFiles: [], apexTestMap: {}, canDeploy: true, orgAliasSet: true,
});

(async () => {
    // Dev deploy: must never invoke the gate at all (nothing before it).
    await panel._runAction({ env: "dev", actionMode: "validate", selectionMode: "all" });
    const devOk = gateChecked.length === 0;
    console.log(`${devOk ? "PASS" : "FAIL"}: dev action never checks a gate (checked: ${gateChecked.join(",")})`);

    // QA (first promotable env) deploy: must ALSO never gate — same as before this change.
    gateChecked = [];
    await panel._runAction({ env: "qa", actionMode: "validate", selectionMode: "all" });
    const qaOk = gateChecked.length === 0;
    console.log(`${qaOk ? "PASS" : "FAIL"}: qa (first promotable env) action never checks a gate (checked: ${gateChecked.join(",")})`);

    // UAT (second promotable env) deploy: MUST gate against qa, exactly as before.
    gateChecked = [];
    await panel._runAction({ env: "uat", actionMode: "validate", selectionMode: "all" });
    const uatOk = gateChecked.length === 1 && gateChecked[0] === "qa";
    console.log(`${uatOk ? "PASS" : "FAIL"}: uat action gates against qa (checked: ${gateChecked.join(",")})`);

    process.exit(devOk && qaOk && uatOk ? 0 : 1);
})();
