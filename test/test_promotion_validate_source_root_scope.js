// Regression test for a real reported bug: a promotion's mandatory Validate step diffed
// the ENTIRE repo (targetBranch vs promotionBranch, no pathspec) instead of scoping to the
// configured source root — so any file changed outside force-app (a stray file at the repo
// root, docs, CI config) got swept into `sourceDirs` and handed straight to
// `sf project deploy --source-dir`, which fails the CLI outright for anything that isn't
// real deployable metadata under the source root (crashing the WHOLE validate, not just
// skipping the one bad entry). Real-world trigger: a story's feature branch picked up a
// stray "manifest/<?xml version=\"1.xml" file (garbage from an unrelated mistake, added
// outside force-app/) — that alone was enough to fail Validate with "File or folder not
// found", with zero connection to the story's actual Salesforce changes.
//
// DeploymentDashboardPanel's equivalent diff already passed the source root as a pathspec
// (see its own diffNameStatusBetween(env.branch, nextEnv.branch, sourceRoot) call) —
// runPromotionValidate just hadn't been scoped the same way.

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
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "NoTestRun" }];
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

    // storyChangedFiles (audit-only, unrelated to what's actually deployed) also calls
    // diffNameStatusBetween, with no pathspec — recording every call (rather than just the
    // last) avoids that unrelated call clobbering the one this test cares about.
    const diffCalls = [];
    const gh = {
        tryBeginOperation: () => true,
        endOperation: () => {},
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        getPendingOperation: async () => null,
        isSignoffPassed: async () => true,
        promotionBranchExists: async () => true,
        previewStoryFiles: async () => [{ path: "force-app/main/default/classes/Utils.cls", change: "modified" }],
        currentBranch: async () => "main",
        hasUncommittedChanges: async () => false,
        stagedFiles: async () => [], workingTreeFiles: async () => [],
        createLocalBranchFrom: async () => {},
        conflictingPendingOperation: async () => undefined,
        beginPromotion: async () => ({ status: "clean", branch: "promotion/PC1-to-qa", conflicts: [] }),
        finalizePromotion: async () => ({ branch: "promotion/PC1-to-qa", tag: "" }),
        promoBranchName: (storyId, env, mode) => `${mode}/${storyId}-to-qa`,
        // The real repo's actual diff (no pathspec) DOES contain a stray file outside
        // force-app — this fake asserts the pathspec argument itself, then returns what a
        // properly-scoped `git diff -- force-app` would (the stray file excluded), since
        // that's the fix being verified: runPromotionValidate must now pass it.
        diffNameStatusBetween: async (fromRef, toRef, pathspec) => {
            diffCalls.push({ fromRef, toRef, pathspec });
            const all = [
                { path: "force-app/main/default/classes/Utils.cls", change: "modified" },
                { path: "manifest/<?xml version=\"1.xml", change: "added" },
            ];
            return pathspec ? all.filter(f => f.path.startsWith(pathspec + "/")) : all;
        },
        listFilesAtRef: async () => [],
        getWorkspaceRoot: () => "/tmp",
        checkoutFeature: async () => {},
        appendAudit: async () => {},
        isPromotionValidated: async () => false,
        recordPromotionValidated: async () => {},
    };

    await runPromotion(bbClient, gh, "PC1", "qa", "validate", storyProvider);

    const validateDiffCall = diffCalls.find(c => c.toRef === "promote/PC1-to-qa");
    check("Validate's diff is scoped to the configured source root", validateDiffCall && validateDiffCall.pathspec === "force-app", JSON.stringify(validateDiffCall));
    check("a stray file outside the source root never reaches --source-dir", capturedArgs && !capturedArgs.sourceDirs.some(p => p.startsWith("manifest/")), capturedArgs && JSON.stringify(capturedArgs.sourceDirs));
    check("the story's real, in-scope file still deploys", capturedArgs && capturedArgs.sourceDirs.includes("force-app/main/default/classes/Utils.cls"), capturedArgs && JSON.stringify(capturedArgs.sourceDirs));

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
