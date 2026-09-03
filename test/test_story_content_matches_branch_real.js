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
const cfgValues = { baseBranch: "main" };
fakeVscode.workspace.getConfiguration = () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d) });

const { GitHelper } = require("../out/GitHelper.js");
const gh = new GitHelper();

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    await gh.fetchRemote();

    // feature/TEST3 vs the base branch it was cut from — must NOT match (there's a real,
    // known diff — that's the whole story). Confirms the method doesn't just always return true.
    const vsBase = await gh.storyContentMatchesBranch("TEST3", "main");
    check("TEST3's content does NOT already match main (real, known diff)", vsBase === false, vsBase);

    // feature/TEST3 vs itself's own branch name obviously has zero diff for its own files.
    const vsSelf = await gh.storyContentMatchesBranch("TEST3", "feature/TEST3");
    check("TEST3's content matches its own feature branch trivially", vsSelf === true, vsSelf);

    // A story id with no feature branch at all -> "nothing to compare", treated as matching
    // (no false "stale" for something that was never a real promotable story).
    const noBranch = await gh.storyContentMatchesBranch("NO-SUCH-STORY-XYZ", "qa");
    check("no feature branch -> treated as matching (nothing to flag as stale)", noBranch === true, noBranch);

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
