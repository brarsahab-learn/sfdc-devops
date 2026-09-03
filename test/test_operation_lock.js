const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let lastWarningMsg = null;
fakeVscode.window.showWarningMessage = async (msg) => { lastWarningMsg = msg; return undefined; };
fakeVscode.window.showInformationMessage = async () => undefined;
fakeVscode.window.showErrorMessage = async () => undefined;
fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
fakeVscode.ProgressLocation = { Notification: 1 };

const config = require("../out/config.js");
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "RunLocalTests" }];
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
config.findEnvironment = (name) => config.getEnvironments().find(e => e.name === name);
config.getCoverageGateEnvironment = () => undefined;
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
config.featureBranchName = (id) => `feature/${id}`;

const { GitHelper } = require("../out/GitHelper.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. GitHelper.tryBeginOperation / endOperation: the core primitive ----
    {
        const gh = Object.create(GitHelper.prototype); gh._inFlightOperations = new Set();
        check("first call for a key succeeds", gh.tryBeginOperation("x") === true);
        check("second call for the SAME key while still in-flight fails", gh.tryBeginOperation("x") === false);
        gh.endOperation("x");
        check("after ending, the same key can begin again", gh.tryBeginOperation("x") === true);
        check("a DIFFERENT key is independent", gh.tryBeginOperation("y") === true);
    }

    // ---- 2. runPromotion: a second call for the SAME story+env while one is in flight is refused ----
    {
        const { runPromotion } = require("../out/commands/promoteStory.js");
        const gh = Object.create(GitHelper.prototype); gh._inFlightOperations = new Set();
        let checkPrevCalls = 0;
        // Needs a promotable env BEFORE qa (targetIdx > 0) so runPromotion's prev-stage gate —
        // and thus this stub's 50ms delay — is actually reached; with qa alone at index 0 the
        // gate is skipped entirely and the whole call resolves before the second one even fires.
        config.getPromotableEnvironments = () => [
            { name: "dev", label: "Dev", branch: "dev" },
            { name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "RunLocalTests" },
        ];
        gh.checkPrevEnvDeployed = async () => { checkPrevCalls++; await new Promise(r => setTimeout(r, 50)); return { blocked: false }; };
        gh.resolveRepoIdentity = async () => undefined;
        gh.isSignoffPassed = async () => true;
        gh.promotionBranchExists = async () => false;
        gh.previewStoryFiles = async () => [{ path: "force-app/classes/Foo.cls", change: "modified" }];
        gh.currentBranch = async () => "main";
        gh.hasUncommittedChanges = async () => false;

        lastWarningMsg = null;
        const first = runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST-9", "qa", "promote", { refresh: () => {} });
        // Fire the second call while the first is still mid-flight (checkPrevEnvDeployed sleeps 50ms).
        await new Promise(r => setTimeout(r, 5));
        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST-9", "qa", "promote", { refresh: () => {} });
        check("second concurrent call is refused with a clear message", lastWarningMsg && lastWarningMsg.includes("Already") && lastWarningMsg.includes("give it a moment"), lastWarningMsg);
        check("the gate underneath only actually ran once (no overlap)", checkPrevCalls === 1, checkPrevCalls);
        await first; // let the first one finish so it doesn't leak into other tests
    }

    // ---- 3. runPromotion: a DIFFERENT env for the same story is NOT blocked (independent lock) ----
    {
        const { runPromotion } = require("../out/commands/promoteStory.js");
        const gh = Object.create(GitHelper.prototype); gh._inFlightOperations = new Set();
        let checkPrevCalls = 0;
        gh.checkPrevEnvDeployed = async () => { checkPrevCalls++; return { blocked: false }; };
        gh.isSignoffPassed = async () => true;
        gh.promotionBranchExists = async () => false;
        gh.previewStoryFiles = async () => [];
        gh.currentBranch = async () => "main";
        gh.hasUncommittedChanges = async () => false;
        config.getPromotableEnvironments = () => [
            { name: "qa", label: "QA", branch: "qa" },
            { name: "uat", label: "UAT", branch: "uat" },
        ];

        lastWarningMsg = null;
        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST-9", "qa", "validate", { refresh: () => {} });
        const warnAfterQa = lastWarningMsg;
        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST-9", "uat", "validate", { refresh: () => {} });
        check("promoting a different env for the same story isn't blocked by the qa lock", lastWarningMsg === warnAfterQa || !(lastWarningMsg && lastWarningMsg.includes("Already")));
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
