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

// Deliberately NOT overriding ticketKeyPattern — the real Insurebridge-test settings.json
// doesn't set it either, so this must reflect config.ts's actual default (Jira-shaped
// PROJECT-123), not a permissive stand-in.
const cfgValues = {
    "environments": [{ name: "dev" }, { name: "qa", orgAlias: "QA-LIVE" }, { name: "uat", orgAlias: "UAT-LIVE" }],
    "devOrgAlias": "QA1-ZIB", "prodOrgAlias": "IB-LIVE", "baseBranch": "main",
};
fakeVscode.workspace.getConfiguration = () => ({ get: (key, def) => (key in cfgValues ? cfgValues[key] : def) });

const { GitHelper } = require("../out/GitHelper.js");
const { distinctStoryIdsFromCommits } = require("../out/DeploymentPlanner.js");
const { getTicketKeyPattern, getPromotableEnvironments, getPublishEnvironment } = require("../out/config.js");

const gh = new GitHelper();
let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

async function findPromotionCandidates(prevBranch, targetBranch) {
    const commits = await gh.commitLogBetween(targetBranch, prevBranch);
    const byStory = distinctStoryIdsFromCommits(commits, getTicketKeyPattern());
    const out = [];
    for (const [storyId] of byStory) {
        const already = await gh.storyCommitShaOnBranch(targetBranch, storyId);
        if (!already) { out.push(storyId); }
    }
    return out.sort();
}

(async () => {
    // qa's candidates: stories on dev not yet on qa
    const qaCandidates = await findPromotionCandidates("dev", "qa");
    console.log("qa candidates:", qaCandidates);
    check("qa candidates is a real list (not throwing, not everything)", Array.isArray(qaCandidates));
    check("qa candidates exclude the stray 'test' commit (real default pattern requires PROJECT-123 shape)", !qaCandidates.includes("test"));

    // uat's candidates: stories on qa not yet on uat
    const uatCandidates = await findPromotionCandidates("qa", "uat");
    console.log("uat candidates:", uatCandidates);
    check("uat candidates is a real list", Array.isArray(uatCandidates));
    // TEST_2 is on qa but not uat (per earlier progress readout) -> should appear here
    check("uat candidates include TEST_2 (on qa, not on uat)", uatCandidates.includes("TEST_2"));
    // TEST-INITIAL is already on uat -> should NOT appear
    check("uat candidates exclude TEST-INITIAL (already promoted)", !uatCandidates.includes("TEST-INITIAL"));

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
