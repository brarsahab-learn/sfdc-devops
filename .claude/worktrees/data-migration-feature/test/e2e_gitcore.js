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

const { GitHelper } = require("../out/GitHelper.js");
const { getStoryProgress } = require("../out/StoryProgress.js");
const { getEnvironments, getPromotableEnvironments, getPublishEnvironment } = require("../out/config.js");

const gh = new GitHelper();
const bbClient = { buildPrUrl: () => null, buildBranchUrl: () => null };

let allPass = true;
function check(name, cond, extra) {
    console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
    if (!cond) { allPass = false; }
}

(async () => {
    console.log("== config ==");
    const envs = getEnvironments();
    check("3 environments resolved", envs.length === 3, JSON.stringify(envs.map(e => e.name)));
    check("dev is publish env", getPublishEnvironment().name === "dev");
    check("promotable = qa, uat", getPromotableEnvironments().map(e => e.name).join(",") === "qa,uat");

    console.log("== story progress: TEST-INITIAL ==");
    try {
        const p1 = await getStoryProgress(gh, bbClient, "TEST-INITIAL");
        console.log("  progress:", JSON.stringify(p1));
        check("TEST-INITIAL progress has dev/qa/uat keys", "dev" in p1 && "qa" in p1 && "uat" in p1);
    } catch (e) {
        check("TEST-INITIAL progress computed without throwing", false, e.stack);
    }

    console.log("== story progress: TEST_2 ==");
    try {
        const p2 = await getStoryProgress(gh, bbClient, "TEST_2");
        console.log("  progress:", JSON.stringify(p2));
        check("TEST_2 progress has dev/qa/uat keys", "dev" in p2 && "qa" in p2 && "uat" in p2);
    } catch (e) {
        check("TEST_2 progress computed without throwing", false, e.stack);
    }

    console.log("== checkPrevEnvDeployed ==");
    for (const env of getPromotableEnvironments()) {
        try {
            const idx = getPromotableEnvironments().findIndex(e => e.name === env.name);
            const prev = idx > 0 ? getPromotableEnvironments()[idx - 1] : getPublishEnvironment();
            const gap = await gh.checkPrevEnvDeployed(prev, env.label);
            console.log(`  ${env.name}: prev=${prev.name} ->`, JSON.stringify(gap));
            check(`checkPrevEnvDeployed(${prev.name}) doesn't throw`, true);
        } catch (e) {
            check(`checkPrevEnvDeployed for ${env.name} doesn't throw`, false, e.stack);
        }
    }

    console.log("== mergeBase + commitLogBetweenRaw for each env ==");
    const allEnvs = [getPublishEnvironment(), ...getPromotableEnvironments()];
    for (let i = 0; i < allEnvs.length; i++) {
        const env = allEnvs[i];
        const prevBranch = i > 0 ? allEnvs[i - 1].branch : "main";
        try {
            const mb = await gh.mergeBase(prevBranch, env.branch);
            const currentSha = await gh.remoteHeadSha(env.branch);
            const lastDeploy = await gh.getDeployState(env.name);
            const baseline = lastDeploy?.sha ?? mb;
            let commits = [];
            if (baseline && currentSha && baseline !== currentSha) {
                commits = await gh.commitLogBetweenRaw(baseline, `origin/${env.branch}`);
            }
            console.log(`  ${env.name}: mergeBase=${mb}, currentSha=${currentSha}, lastDeploy=${lastDeploy ? lastDeploy.sha : null}, commits=${commits.length}`);
            const hasMerge = commits.some(c => /^Merge pull request/.test(c.message));
            check(`${env.name}: no merge-commit pollution`, !hasMerge, JSON.stringify(commits.map(c => c.message)));
        } catch (e) {
            check(`${env.name}: mergeBase/commitLog doesn't throw`, false, e.stack);
        }
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
