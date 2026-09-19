const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let warningResponses = [];
let infoResponses = [];
let lastWarningMsg = null, lastInfoMsg = null;
fakeVscode.window.showWarningMessage = async (msg) => { lastWarningMsg = msg; return warningResponses.shift(); };
fakeVscode.window.showInformationMessage = async (msg) => { lastInfoMsg = msg; return infoResponses.shift(); };
fakeVscode.window.showErrorMessage = async (msg) => { lastErrorMsg = msg; };
let lastErrorMsg = null;
fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
fakeVscode.ProgressLocation = { Notification: 1 };
fakeVscode.env = { openExternal: async () => {} };
fakeVscode.commands = { executeCommand: async () => undefined };

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

const config = require("../out/config.js");
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "RunLocalTests" }];
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "RunLocalTests" }];
config.findEnvironment = (name) => config.getEnvironments().find(e => e.name === name);
config.getCoverageGateEnvironment = () => undefined;
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
config.getBaseBranch = () => "main";
config.featureBranchName = (id) => `feature/${id}`;
config.getSourceRootFolder = () => "force-app";
config.getDeployTimeoutSeconds = () => 900;

const deployEngine = require("../out/DeploymentEngine.js");

function makeGitHelper(overrides) {
    const validated = {};
    return Object.assign({
        tryBeginOperation: () => true,
        endOperation: () => {},
        resolveRepoIdentity: async () => undefined,
        getPendingOperation: async () => null,
        conflictingPendingOperation: async () => undefined,
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        isSignoffPassed: async () => true,
        promotionBranchExists: async () => false,
        previewStoryFiles: async () => [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
        beginPromotion: async () => ({ status: "clean", branch: "promotion/TEST-9-to-qa", conflicts: [] }),
        finalizePromotion: async () => ({ branch: "promotion/TEST-9-to-qa", tag: "" }),
        createLocalBranchFrom: async () => {},
        diffNameStatusBetween: async () => [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
        listFilesAtRef: async () => [],
        currentBranch: async () => "main",
        hasUncommittedChanges: async () => false,
        stagedFiles: async () => [],
        workingTreeFiles: async () => [],
        getWorkspaceRoot: () => "/tmp",
        checkoutFeature: async () => {},
        appendAudit: async () => {},
        remoteHeadSha: async () => "sha1",
        isPromotionValidated: async (storyId, env) => Boolean(validated[`${storyId}::${env}`]),
        recordPromotionValidated: async (storyId, env) => { validated[`${storyId}::${env}`] = true; },
        featureApexClasses: async () => [],
        promoBranchName: (storyId, env, mode) => `${mode}/${storyId}-to-${env}`,
        _validated: validated,
    }, overrides);
}

(async () => {
    const { runPromotion, openPromotionPR } = require("../out/commands/promoteStory.js");
    const bbClient = { buildPrUrl: () => "https://example.com/pr/1", getOpenPRUrl: async () => null };
    const storyProvider = { refresh: () => {} };

    // ---- 1. Fresh promotion: validate PASSES -> PR opens ----
    {
        let deployCalls = 0;
        const gh = makeGitHelper({});
        deployEngine.runDeploy = async () => { deployCalls++; return { ran: true, success: true, numberComponentsDeployed: 3 }; };
        warningResponses = ["Yes, Promote"]; infoResponses = [];
        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", storyProvider);
        check("real validate (runDeploy) was actually called", deployCalls === 1);
        check("validation gets recorded on success", gh._validated["TEST-9::qa"] === true);
        check("info message confirms PR pushed", lastInfoMsg && lastInfoMsg.includes("pushed"), lastInfoMsg);
    }

    // ---- 2. Fresh promotion: validate FAILS -> PR must NOT open ----
    {
        let openExternalCalled = false;
        fakeVscode.env.openExternal = async () => { openExternalCalled = true; };
        const gh = makeGitHelper({});
        deployEngine.runDeploy = async () => ({ ran: true, success: false, error: "Utils.cls:12: Invalid type" });
        warningResponses = ["Yes, Promote"]; infoResponses = [];
        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", storyProvider);
        check("validation failure recorded as NOT validated", gh._validated["TEST-9::qa"] === undefined);
        check("PR was never opened when validation failed", !openExternalCalled);
        check("error message surfaces the real failure detail", lastErrorMsg && lastErrorMsg.includes("Invalid type"), lastErrorMsg);
    }

    // ---- 3. Validate Only: passes but must NOT open a PR ----
    {
        let openExternalCalled = false;
        fakeVscode.env.openExternal = async () => { openExternalCalled = true; };
        const gh = makeGitHelper({});
        deployEngine.runDeploy = async () => ({ ran: true, success: true, numberComponentsDeployed: 1 });
        warningResponses = ["Yes, validate against QA"]; infoResponses = [];
        await runPromotion(bbClient, gh, "TEST-9", "qa", "validate", storyProvider);
        check("Validate Only stops after validating — never opens a PR", !openExternalCalled);
        check("Validate Only still records the pass (Promote can reuse it)", gh._validated["TEST-9::qa"] === true);
    }

    // ---- 4. Copado reuse: branch exists AND already validated -> opens PR WITHOUT re-validating ----
    {
        let deployCalls = 0;
        deployEngine.runDeploy = async () => { deployCalls++; return { ran: true, success: true }; };
        const gh = makeGitHelper({
            promotionBranchExists: async () => true,
            isPromotionValidated: async () => true,
        });
        warningResponses = ["Yes, open PR"]; infoResponses = [];
        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", storyProvider);
        check("already-validated reuse opens PR without re-running validate", deployCalls === 0);
    }

    // ---- 5. Branch exists but NOT validated -> must re-validate before opening PR (the loophole this closes) ----
    {
        let deployCalls = 0;
        deployEngine.runDeploy = async () => { deployCalls++; return { ran: true, success: true }; };
        const gh = makeGitHelper({
            promotionBranchExists: async () => true,
            isPromotionValidated: async () => false,
        });
        warningResponses = ["Yes, Promote"]; infoResponses = [];
        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", storyProvider);
        check("stale/unvalidated existing branch is re-validated before any PR", deployCalls === 1);
    }

    // ---- 6. Defense in depth: openPromotionPR refuses directly if not validated ----
    {
        let openExternalCalled = false;
        fakeVscode.env.openExternal = async () => { openExternalCalled = true; };
        const gh = makeGitHelper({ isPromotionValidated: async () => false });
        await openPromotionPR(bbClient, gh, "TEST-9", "qa", storyProvider);
        check("openPromotionPR refuses outright when not validated", !openExternalCalled);
        check("openPromotionPR explains why", lastErrorMsg && lastErrorMsg.includes("validation"), lastErrorMsg);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
