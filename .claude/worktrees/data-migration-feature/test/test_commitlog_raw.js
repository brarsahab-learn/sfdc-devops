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

const { GitHelper } = require("../out/GitHelper.js");
const gh = new GitHelper();

(async () => {
    const mb = await gh.mergeBase("dev", "qa");
    console.log("merge-base:", mb);
    const commits = await gh.commitLogBetweenRaw(mb, "origin/qa");
    console.log("commits found:", commits.length);
    commits.forEach(c => console.log(" -", c.hash.slice(0,7), c.message));
    const hasMerge = commits.some(c => /^Merge pull request/.test(c.message));
    console.log(hasMerge ? "FAIL: merge commit leaked through" : "PASS: no merge commits in the list");
    process.exit(hasMerge ? 1 : 0);
})();
