const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
fakeVscode.window.showWarningMessage = async (m) => { console.log("WARN:", m); return "Yes, validate against QA"; };
fakeVscode.window.showInformationMessage = async (m) => { console.log("INFO:", m); };
fakeVscode.window.showErrorMessage = async (m) => { console.log("ERROR:", m); };
fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
fakeVscode.ProgressLocation = { Notification: 1 };

const config = require("../out/config.js");
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "RunLocalTests" }];
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
config.findEnvironment = (name) => config.getEnvironments().find(e => e.name === name)
    ? { ...config.getPromotableEnvironments().find(e => e.name === name) } : undefined;
config.findEnvironment = (name) => config.getPromotableEnvironments().find(e => e.name === name);
config.getCoverageGateEnvironment = () => undefined;
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
config.getBaseBranch = () => "main";
config.featureBranchName = (id) => `feature/${id}`;
config.getSourceRootFolder = () => "force-app";
config.getDeployTimeoutSeconds = () => 900;

const deployEngine = require("../out/DeploymentEngine.js");
let capturedArgs = null;
deployEngine.runDeploy = async (workspaceRoot, sourceRoot, sourceDirs, orgAlias, testLevel, timeout, mode, tests) => {
    capturedArgs = { sourceDirs, testLevel, tests };
    return { ran: true, success: true, numberComponentsDeployed: sourceDirs.length };
};

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const { runPromotion } = require("../out/commands/promoteStory.js");
    const bbClient = {};
    const storyProvider = { refresh: () => {} };

    const gh = {
        tryBeginOperation: () => true,
        endOperation: () => {},
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        getPendingOperation: async () => null,
        isSignoffPassed: async () => true,
        promotionBranchExists: async () => true, // reuse path — branch already exists
        previewStoryFiles: async () => [{ path: "force-app/main/default/classes/Utils.cls", change: "modified" }],
        currentBranch: async () => "main",
        hasUncommittedChanges: async () => false,
        stagedFiles: async () => [], workingTreeFiles: async () => [],
        createLocalBranchFrom: async () => {},
        conflictingPendingOperation: async () => undefined,
        beginPromotion: async () => ({ status: "clean", branch: "promotion/TEST3-to-qa", conflicts: [] }),
        finalizePromotion: async () => ({ branch: "promotion/TEST3-to-qa", tag: "" }),
        promoBranchName: (storyId, env, mode) => `${mode}/${storyId}-to-${env}`,
        // The promotion's diff: just Utils.cls changed — its test (UtilsTest) is NOT
        // itself part of this diff (already exists on the branch from an earlier promotion).
        diffNameStatusBetween: async () => [{ path: "force-app/main/default/classes/Utils.cls", change: "modified" }],
        // Full branch listing used for auto-detection — includes UtilsTest.cls, proving the
        // detector isn't limited to just the diff.
        listFilesAtRef: async () => [
            "force-app/main/default/classes/Utils.cls",
            "force-app/main/default/classes/UtilsTest.cls",
            "force-app/main/default/classes/UtilsTest.cls-meta.xml",
            "force-app/main/default/classes/Unrelated.cls",
            "force-app/main/default/classes/UnrelatedTest.cls",
        ],
        getWorkspaceRoot: () => "/tmp",
        checkoutFeature: async () => {},
        appendAudit: async () => {},
        isPromotionValidated: async () => false,
        recordPromotionValidated: async () => {},
    };

    await runPromotion(bbClient, gh, "TEST3", "qa", "validate", storyProvider);

    check("does NOT fall back to the slow static RunLocalTests default", capturedArgs && capturedArgs.testLevel !== "RunLocalTests", capturedArgs && capturedArgs.testLevel);
    check("auto-detects RunSpecifiedTests instead", capturedArgs && capturedArgs.testLevel === "RunSpecifiedTests", capturedArgs && JSON.stringify(capturedArgs));
    check("names exactly the relevant test (UtilsTest), not the whole org's suite", capturedArgs && capturedArgs.tests && capturedArgs.tests.length === 1 && capturedArgs.tests[0] === "UtilsTest", capturedArgs && JSON.stringify(capturedArgs.tests));
    check("folds UtilsTest.cls's own files into the deploy even though they weren't in the diff", capturedArgs && capturedArgs.sourceDirs.includes("force-app/main/default/classes/UtilsTest.cls") && capturedArgs.sourceDirs.includes("force-app/main/default/classes/UtilsTest.cls-meta.xml"), capturedArgs && JSON.stringify(capturedArgs.sourceDirs));
    check("does NOT pull in the unrelated class's test", capturedArgs && !capturedArgs.tests.includes("UnrelatedTest"));

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
