const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let lastWarningMsg = null;
fakeVscode.window.showWarningMessage = async (msg, ...actions) => { lastWarningMsg = msg; return actions[actions.length - 1]; };
fakeVscode.window.showInformationMessage = async () => undefined;
fakeVscode.window.showErrorMessage = async () => undefined;
fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
fakeVscode.ProgressLocation = { Notification: 1 };

const config = require("../out/config.js");
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "NoTestRun" }];
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
config.findEnvironment = (name) => config.getEnvironments().find(e => e.name === name);
config.getCoverageGateEnvironment = () => undefined;
config.getBaseBranch = () => "main";
config.featureBranchName = (id) => `feature/${id}`;
config.getSourceRootFolder = () => "force-app";
config.getDeployTimeoutSeconds = () => 900;
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;

const deployEngine = require("../out/DeploymentEngine.js");
deployEngine.runDeploy = async () => ({ ran: true, success: true, numberComponentsDeployed: 1 });

const { runPromotion } = require("../out/commands/promoteStory.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function baseGh(overrides) {
    return Object.assign({
        tryBeginOperation: () => true,
        endOperation: () => {},
        currentBranch: async () => "feature/TEST3",
        resolveRepoIdentity: async () => undefined,
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        isSignoffPassed: async () => true,
        hasUncommittedChanges: async () => false,
        previewStoryFiles: async () => [{ path: "force-app/main/default/classes/Utils.cls", change: "modified" }],
        diffNameStatusBetween: async () => [{ path: "force-app/main/default/classes/Utils.cls", change: "modified" }],
        listFilesAtRef: async () => [],
        getWorkspaceRoot: () => "/tmp",
        checkoutFeature: async () => {},
        appendAudit: async () => {},
        createLocalBranchFrom: async () => {},
        isPromotionValidated: async () => false,
        recordPromotionValidated: async () => {},
    }, overrides);
}

(async () => {
    // ---- 1. Existing-but-unvalidated branch: refreshed (beginPromotion actually runs), not just reused ----
    {
        let beginCalls = 0, finalizeCalls = 0;
        const gh = baseGh({
            promotionBranchExists: async () => true,
            getPendingOperation: async () => null,
            conflictingPendingOperation: async () => undefined,
            beginPromotion: async () => { beginCalls++; return { status: "clean", branch: "promotion/TEST3-to-qa", conflicts: [] }; },
            finalizePromotion: async () => { finalizeCalls++; return { branch: "promotion/TEST3-to-qa", tag: "" }; },
        });
        lastWarningMsg = null;
        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST3", "qa", "validate", { refresh: () => {} });
        check("beginPromotion actually runs for an existing unvalidated branch", beginCalls === 1, beginCalls);
        check("finalizePromotion (push) actually runs too", finalizeCalls === 1, finalizeCalls);
        check("confirm dialog says Refresh, not Reuse", lastWarningMsg && lastWarningMsg.includes("Refresh") && !lastWarningMsg.includes("Reuse"), lastWarningMsg);
    }

    // ---- 2. A pending conflict for THIS exact story+env: refused, told to Resume, nothing touched ----
    {
        let beginCalls = 0;
        const gh = baseGh({
            promotionBranchExists: async () => true,
            getPendingOperation: async () => ({ kind: "promotion", storyId: "TEST3", targetEnv: "qa", mode: "validate" }),
            beginPromotion: async () => { beginCalls++; return { status: "clean", branch: "promotion/TEST3-to-qa", conflicts: [] }; },
        });
        lastWarningMsg = null;
        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST3", "qa", "validate", { refresh: () => {} });
        check("own pending conflict blocks the run entirely", beginCalls === 0, beginCalls);
        check("tells the user to Resume instead", lastWarningMsg && lastWarningMsg.includes("Resume"), lastWarningMsg);
    }

    // ---- 3. A pending conflict for a DIFFERENT story+env: still offers to discard and continue (unchanged) ----
    {
        let beginCalls = 0, discardSeen = null;
        const gh = baseGh({
            promotionBranchExists: async () => true,
            getPendingOperation: async () => ({ kind: "promotion", storyId: "OTHER-1", targetEnv: "qa", mode: "promote" }),
            conflictingPendingOperation: async () => ({ storyId: "OTHER-1", targetEnv: "qa" }),
            beginPromotion: async (storyId, targetEnv, mode, targetBranch, discard) => { beginCalls++; discardSeen = discard; return { status: "clean", branch: "promotion/TEST3-to-qa", conflicts: [] }; },
            finalizePromotion: async () => ({ branch: "promotion/TEST3-to-qa", tag: "" }),
        });
        lastWarningMsg = null;
        await runPromotion({ getOpenPRUrl: async () => null }, gh, "TEST3", "qa", "validate", { refresh: () => {} });
        check("still offers to discard the OTHER story's conflict", lastWarningMsg && lastWarningMsg.includes("OTHER-1"), lastWarningMsg);
        check("proceeds with discard=true once confirmed", beginCalls === 1 && discardSeen === true, JSON.stringify({ beginCalls, discardSeen }));
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
