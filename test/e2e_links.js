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
fakeVscode.workspace.getConfiguration = () => ({ get: (key, def) => def });

const { GitHelper } = require("../out/GitHelper.js");
const { createGitProviderClient } = require("../out/GitProviderClient.js");

const gh = new GitHelper();
const fakeContext = { globalState: { get: () => undefined }, secrets: { get: async () => undefined } };

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const remoteUrl = await gh.getRemoteUrl();
    const bbClient = createGitProviderClient(fakeContext, remoteUrl);
    const repoOverride = await gh.resolveRepoIdentity(bbClient);
    console.log("repoOverride:", repoOverride);

    const branchUrl = bbClient.buildBranchUrl("feature/TEST-INITIAL", repoOverride);
    check("buildBranchUrl resolves", typeof branchUrl === "string" && branchUrl.startsWith("http"), branchUrl);

    const prUrl = bbClient.buildPrUrl("promotion/TEST-INITIAL-to-qa", "qa", repoOverride);
    check("buildPrUrl resolves", typeof prUrl === "string" && prUrl.startsWith("http"), prUrl);

    process.exit(allPass ? 0 : 1);
})();
