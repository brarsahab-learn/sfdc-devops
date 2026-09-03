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
const { StoryWebviewProvider } = require("../out/providers/StoryWebviewProvider.js");
const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");
const { getStoryProgress } = require("../out/StoryProgress.js");
const { getPromotableEnvironments, getPublishEnvironment } = config;

const gh = new GitHelper();
const bbClient = { buildPrUrl: () => null, buildBranchUrl: () => null };

let allPass = true;
function check(name, cond, extra) {
    console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`);
    if (!cond) { allPass = false; }
}

(async () => {
    // ---- Story Progress webview for TEST-INITIAL (qa merged, uat ALSO merged — the exact single-step scenario) ----
    const progress = await getStoryProgress(gh, bbClient, "TEST-INITIAL");
    const provider = Object.create(StoryWebviewProvider.prototype);
    provider._bbClient = bbClient;
    provider._extContext = {
        extension: { packageJSON: { version: "3.13.1" } },
        globalState: { get: () => undefined, update: async () => undefined },
    };
    provider._forceShowSetup = false;

    try {
        const html = provider._getWebviewHtml("feature/TEST-INITIAL", "TEST-INITIAL", progress, 0, null, undefined, {}, null, {});
        check("Story Progress HTML renders without throwing", true);
        // The "single-step lock" scenario itself (qa merged, uat next locked) is covered
        // deterministically by test_single_step.js/test_single_step2.js with mocked progress —
        // asserting it here against the REAL repo's live progress is fragile by construction:
        // any later real promotion in this repo (e.g. a subsequent story's genuine end-to-end
        // deploy) legitimately advances qa/uat's deploy state and invalidates the assumption,
        // exactly as happened here. Render-without-throwing + no template artifacts is what
        // this real-data smoke test can actually keep guaranteeing.
        check("no unresolved template artifacts (undefined/[object", !/undefined|\[object Object\]/.test(html));
    } catch (e) {
        check("Story Progress HTML renders without throwing", false, e.stack);
    }

    // ---- Deployment Dashboard: build real view models for dev/qa/uat and render each pane ----
    const panel = Object.create(DeploymentDashboardPanel.prototype);
    panel._gitHelper = gh;
    panel._validatedSelections = new Map();
    panel._lastOutcome = undefined;
    panel._extContext = { globalState: { get: () => undefined } };

    const allEnvs = [getPublishEnvironment(), ...getPromotableEnvironments()];
    const models = [];
    for (let i = 0; i < allEnvs.length; i++) {
        const prevEnv = i > 0 ? allEnvs[i - 1] : undefined;
        try {
            const m = await panel._buildViewModel(allEnvs[i], allEnvs[i + 1], prevEnv);
            models.push(m);
            check(`_buildViewModel(${allEnvs[i].name}) succeeds`, true, `allFiles=${m.allFiles.length}, groups=${m.groups.length}`);
        } catch (e) {
            check(`_buildViewModel(${allEnvs[i].name}) succeeds`, false, e.stack);
        }
    }

    try {
        const qaModel = models.find(m => m.env.name === "qa");
        const fullHtml = panel._renderHtml(qaModel);
        check("Dashboard full HTML renders without throwing", true);
        check("Dashboard is bound to just qa (no dev/uat panes)", /data-env="qa"/.test(fullHtml) && !/data-env="dev"/.test(fullHtml) && !/data-env="uat"/.test(fullHtml));
        check("Dashboard has no tab bar left", !fullHtml.includes("tabbar") && !fullHtml.includes("setEnvTab"));
        check("Dashboard title reflects the bound env", fullHtml.includes("SF DevOps Deployments — QA"));
        check("no unresolved template artifacts", !/undefined|\[object Object\]/.test(fullHtml));
        // Script syntax check
        const scriptMatch = fullHtml.match(/<script>([\s\S]*)<\/script>/);
        if (scriptMatch) {
            new Function(scriptMatch[1]);
            check("Dashboard script block is syntactically valid", true);
        } else {
            check("Dashboard script block found", false);
        }
    } catch (e) {
        check("Dashboard full HTML renders without throwing", false, e.stack);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
