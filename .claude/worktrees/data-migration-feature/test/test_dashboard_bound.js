const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
const WORKSPACE = process.env.SF_DEVOPS_TEST_REPO || "/Users/hardeepbrar/Documents/CODE/GitHub (Modular Projects)/Insurebridge-test";
if (!require("fs").existsSync(WORKSPACE)) {
    console.log("SKIP — real-repo test: set SF_DEVOPS_TEST_REPO to a real Salesforce DX git repo to run this (see test/README.md).");
    process.exit(0);
}
fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }];
const cfgValues = {
    environments: [{ name: "dev" }, { name: "qa", orgAlias: "QA-LIVE" }, { name: "uat", orgAlias: "UAT-LIVE" }],
    baseBranch: "main",
};
fakeVscode.workspace.getConfiguration = () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d) });

let createdPanels = 0;
let lastHtml = "";
let lastTitle = "";
const fakePanel = {
    get title() { return lastTitle; },
    set title(v) { lastTitle = v; },
    webview: {
        get html() { return lastHtml; },
        set html(v) { lastHtml = v; },
        onDidReceiveMessage: () => ({ dispose() {} }),
    },
    reveal: () => {},
    onDidDispose: () => ({ dispose() {} }),
    dispose: () => {},
};
fakeVscode.window.createWebviewPanel = () => { createdPanels++; return fakePanel; };
fakeVscode.ViewColumn = { One: 1 };

const config = require("../out/config.js");
config.getCurrentRole = () => "Admin";
config.readOrgAliases = () => ({ dev: "", qa: "QA-LIVE", uat: "UAT-LIVE" });

const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const fakeContext = { globalState: { get: () => undefined } };

    DeploymentDashboardPanel.createOrShow({ getWorkspaceRoot: () => WORKSPACE, fetchRemote: async () => {}, remoteHeadSha: async () => null, getDeployState: async () => null, mergeBase: async () => null, commitLogBetweenRaw: async () => [] }, fakeContext, "qa");
    await new Promise(r => setTimeout(r, 50)); // let the async refresh() inside the constructor settle

    check("exactly one panel created for the first open", createdPanels === 1);
    check("bound to qa on first open", lastTitle.includes("QA") && /data-env="qa"/.test(lastHtml));
    check("dev/uat NOT present when bound to qa", !/data-env="dev"/.test(lastHtml) && !/data-env="uat"/.test(lastHtml));

    // Second call, different env — should REBIND the same panel, not open a second one.
    DeploymentDashboardPanel.createOrShow({ getWorkspaceRoot: () => WORKSPACE, fetchRemote: async () => {}, remoteHeadSha: async () => null, getDeployState: async () => null, mergeBase: async () => null, commitLogBetweenRaw: async () => [] }, fakeContext, "dev");
    await new Promise(r => setTimeout(r, 50));

    check("still only one panel ever created (rebound, not duplicated)", createdPanels === 1);
    check("now bound to dev", lastTitle.includes("Dev") && /data-env="dev"/.test(lastHtml));
    check("qa/uat NOT present when bound to dev", !/data-env="qa"/.test(lastHtml) && !/data-env="uat"/.test(lastHtml));

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
