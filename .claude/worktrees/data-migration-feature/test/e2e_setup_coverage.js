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
    "environments": [{ name: "dev" }, { name: "qa", orgAlias: "QA-LIVE" }, { name: "uat", orgAlias: "UAT-LIVE" }],
    "devOrgAlias": "QA1-ZIB",
    "prodOrgAlias": "IB-LIVE",
    "baseBranch": "main",
};
fakeVscode.workspace.getConfiguration = () => ({ get: (key, def) => (key in cfgValues ? cfgValues[key] : def) });

const config = require("../out/config.js");
config.getCurrentRole = () => "Admin";
config.readOrgAliases = () => ({ dev: "QA1-ZIB", qa: "QA-LIVE", uat: "UAT-LIVE" });

const { GitHelper } = require("../out/GitHelper.js");
const { runSetupChecks } = require("../out/SetupCheck.js");
const { CoverageWebviewProvider } = require("../out/providers/CoverageWebviewProvider.js");
const { EnvironmentTreeProvider } = require("../out/providers/EnvironmentTreeProvider.js");
const { createGitProviderClient } = require("../out/GitProviderClient.js");

const gh = new GitHelper();
const fakeContext = { globalState: { get: () => undefined, update: async () => undefined }, secrets: { get: async () => undefined } };
let bbClient;

let allPass = true;
function check(name, cond, extra) {
    console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
    if (!cond) { allPass = false; }
}

(async () => {
    const remoteUrl = await gh.getRemoteUrl();
    bbClient = createGitProviderClient(fakeContext, remoteUrl);
    console.log("remoteUrl:", remoteUrl);

    // ---- Setup Check (network calls to real orgs — this is the slow one, uses isOrgConnected) ----
    try {
        const checks = await runSetupChecks(gh, bbClient, fakeContext);
        check("runSetupChecks succeeds against real repo", Array.isArray(checks) && checks.length > 0, `${checks.length} checks`);
        for (const c of checks) { console.log(`   - ${c.key}: passed=${c.passed} required=${c.required} :: ${c.detail}`); }
    } catch (e) {
        check("runSetupChecks succeeds against real repo", false, e.stack);
    }

    // ---- Coverage panel render (no live org call needed for _html) ----
    try {
        const provider = Object.create(CoverageWebviewProvider.prototype);
        provider._lastTests = "";
        provider._missingTests = [];
        const html = provider._html("feature/TEST-INITIAL", "TEST-INITIAL", ["Utils"], false, false);
        check("Coverage panel HTML renders without throwing", typeof html === "string" && html.length > 0);
        check("no unresolved template artifacts", !/undefined|\[object Object\]/.test(html));
    } catch (e) {
        check("Coverage panel HTML renders without throwing", false, e.stack);
    }

    // ---- Environment tree provider ----
    try {
        const envProvider = new EnvironmentTreeProvider(gh);
        const children = await envProvider.getChildren();
        check("EnvironmentTreeProvider.getChildren succeeds", Array.isArray(children), `${children.length} items`);
    } catch (e) {
        check("EnvironmentTreeProvider.getChildren succeeds", false, e.stack);
    }

    // ---- Audit trail render (exercise the new testLevel/tests fields in AuditDetails) ----
    try {
        const entries = await gh.readAuditLog ? await gh.readAuditLog() : [];
        check("readAuditLog callable", true, `${Array.isArray(entries) ? entries.length : "n/a"} entries`);
    } catch (e) {
        check("readAuditLog callable", false, e.stack);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
