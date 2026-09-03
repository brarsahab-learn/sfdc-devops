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

const { GitHelper } = require("../out/GitHelper.js");
const { getStoryTimelines } = require("../out/StoryProgress.js");

const gh = new GitHelper();

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    await gh.fetchRemote();
    for (const storyId of ["TEST-INITIAL", "TEST_2", "TEST3"]) {
        try {
            const t = await getStoryTimelines(gh, storyId);
            console.log(`\n${storyId}:`, JSON.stringify(t, null, 2));
            check(`${storyId}: getStoryTimelines resolves without throwing`, true);
        } catch (e) {
            check(`${storyId}: getStoryTimelines resolves without throwing`, false, e.stack);
        }
    }
    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
