const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
fakeVscode.window.showInformationMessage = async () => undefined;
fakeVscode.window.showErrorMessage = async () => undefined;

const config = require("../out/config.js");
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa" }];
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
config.findEnvironment = (name) => config.getEnvironments().find(e => e.name === name);
config.getCoverageGateEnvironment = () => undefined;
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
config.featureBranchName = (id) => `feature/${id}`;
config.getBaseBranch = () => "main";
config.getSourceRootFolder = () => "force-app";
config.getDeployTimeoutSeconds = () => 900;

const deployEngine = require("../out/DeploymentEngine.js");
deployEngine.runDeploy = async () => ({ ran: true, success: true, numberComponentsDeployed: 1 });

const { runPromotion } = require("../out/commands/promoteStory.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function baseGh() {
    return {
        tryBeginOperation: () => true,
        endOperation: () => {},
        currentBranch: async () => "feature/TEST-9",
        resolveRepoIdentity: async () => undefined,
        getPendingOperation: async () => null,
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        isSignoffPassed: async () => true,
        promotionBranchExists: async () => false,
        hasUncommittedChanges: async () => false,
        conflictingPendingOperation: async () => undefined,
        previewStoryFiles: async () => [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
        diffNameStatusBetween: async () => [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
        listFilesAtRef: async () => [],
        checkoutFeature: async () => {},
        appendAudit: async () => {},
        isPromotionValidated: async () => false,
        recordPromotionValidated: async () => {},
        getWorkspaceRoot: () => "/tmp",
        promoBranchName: (storyId, env, mode) => `${mode}/${storyId}-to-${env}`,
    };
}

(async () => {
    // ---- 1. "Review Changes" opens the diff review, then re-shows the SAME confirm (doesn't proceed or cancel on its own) ----
    {
        const gh = baseGh();
        let beginCalls = 0;
        gh.beginPromotion = async () => { beginCalls++; return { status: "clean", branch: "promote/TEST-9-to-qa", conflicts: [] }; };
        gh.finalizePromotion = async () => ({ branch: "promote/TEST-9-to-qa", tag: "" });

        let confirmCalls = 0;
        let quickPickCalls = 0;
        const responses = ["Review Changes", "Yes, validate against QA"]; // review once, then actually confirm
        fakeVscode.window.showWarningMessage = async (msg, ...actions) => { confirmCalls++; return responses.shift(); };
        fakeVscode.window.showQuickPick = async () => { quickPickCalls++; return undefined; }; // Esc immediately inside the review loop
        fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
        fakeVscode.ProgressLocation = { Notification: 1 };

        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST-9", "qa", "validate", { refresh: () => {} });

        check("confirm dialog was shown twice (review, then the real choice)", confirmCalls === 2, confirmCalls);
        check("the review's file picker was actually opened", quickPickCalls === 1, quickPickCalls);
        check("only proceeded (beginPromotion) after the SECOND, real confirm", beginCalls === 1, beginCalls);
    }

    // ---- 2. Cancelling the real confirm after reviewing still cancels — review never forces it through ----
    {
        const gh = baseGh();
        let beginCalls = 0;
        gh.beginPromotion = async () => { beginCalls++; return { status: "clean", branch: "promote/TEST-9-to-qa", conflicts: [] }; };

        const responses = ["Review Changes", undefined]; // review once, then dismiss (Esc / backdrop)
        fakeVscode.window.showWarningMessage = async () => responses.shift();
        fakeVscode.window.showQuickPick = async () => undefined;

        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST-9", "qa", "validate", { refresh: () => {} });

        check("dismissing after review still cancels — beginPromotion never runs", beginCalls === 0, beginCalls);
    }

    // ---- 3. Plain Cancel (no review at all) behaves exactly as before — never opens the review ----
    {
        const gh = baseGh();
        let quickPickCalls = 0;
        fakeVscode.window.showWarningMessage = async () => undefined;
        fakeVscode.window.showQuickPick = async () => { quickPickCalls++; return undefined; };

        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST-9", "qa", "validate", { refresh: () => {} });

        check("cancelling outright never opens the review picker", quickPickCalls === 0, quickPickCalls);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
