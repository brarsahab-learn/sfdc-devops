const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let lastWarningMsg = null;
fakeVscode.window.showWarningMessage = async (msg) => { lastWarningMsg = msg; return "Yes, deploy"; };
fakeVscode.window.showInformationMessage = async () => undefined;
fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
fakeVscode.ProgressLocation = { Notification: 1 };

const deployEngine = require("../out/DeploymentEngine.js");
let capturedSourceDirs = null;
deployEngine.runDeploy = async (workspaceRoot, sourceRoot, sourceDirs) => {
    capturedSourceDirs = sourceDirs;
    return { ran: true, success: true, numberComponentsDeployed: sourceDirs.length };
};

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. Dashboard: a deleted file in the selection is dropped from --source-dir, not sent to the CLI ----
    {
        const config = require("../out/config.js");
        config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1" });
        config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", isProd: false }];
        config.canPromote = () => true;

        const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        panel._lastOutcome = undefined;
        panel._extContext = { globalState: { get: () => "Admin" } };
        panel.refresh = async () => {};
        const env = { name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1", deployTestLevel: "NoTestRun" };
        const model = {
            env, groups: [], apexTestMap: {}, apexTestFilePaths: {}, canDeploy: true, orgAliasSet: true,
            allFiles: [
                { path: "force-app/main/default/classes/Foo.cls", change: "modified" },
                { path: "force-app/main/default/classes/Obsolete.cls", change: "deleted" },
                { path: "force-app/main/default/classes/Obsolete.cls-meta.xml", change: "deleted" },
            ],
        };
        panel._buildViewModel = async () => model;
        panel._gitHelper = {
            checkPrevEnvDeployed: async () => ({ blocked: false }),
            tryBeginOperation: () => true,
            endOperation: () => {},
            hasUncommittedChanges: async () => false,
            createLocalBranchFrom: async () => {},
            currentBranch: async () => "main",
            checkoutBranch: async () => {},
            remoteHeadSha: async () => null,
            appendAudit: async () => {},
            getWorkspaceRoot: () => "/tmp",
            remoteBranchExists: async () => false,
        };

        capturedSourceDirs = null; lastWarningMsg = null;
        await panel._runAction({
            env: "dev", actionMode: "validate", selectionMode: "files",
            files: ["force-app/main/default/classes/Foo.cls", "force-app/main/default/classes/Obsolete.cls", "force-app/main/default/classes/Obsolete.cls-meta.xml"],
            testMode: "auto",
        });
        check("only the still-existing file reaches --source-dir", JSON.stringify(capturedSourceDirs) === JSON.stringify(["force-app/main/default/classes/Foo.cls"]), JSON.stringify(capturedSourceDirs));
        check("warns about the skipped deletions instead of crashing", lastWarningMsg && lastWarningMsg.includes("2 deleted file(s)") && lastWarningMsg.includes("Obsolete.cls"), lastWarningMsg);
    }

    // ---- 2. Dashboard: selection is ONLY deletions -> treated as empty, not sent at all ----
    {
        const config = require("../out/config.js");
        const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        panel._extContext = { globalState: { get: () => "Admin" } };
        panel.refresh = async () => {};
        const env = { name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1", deployTestLevel: "NoTestRun" };
        const model = {
            env, groups: [], apexTestMap: {}, apexTestFilePaths: {}, canDeploy: true, orgAliasSet: true,
            allFiles: [{ path: "force-app/main/default/classes/Obsolete.cls", change: "deleted" }],
        };
        panel._buildViewModel = async () => model;
        panel._gitHelper = {
            checkPrevEnvDeployed: async () => ({ blocked: false }),
            tryBeginOperation: () => true,
            endOperation: () => {},
            hasUncommittedChanges: async () => false,
        };

        capturedSourceDirs = null; lastWarningMsg = null;
        let warnCount = 0;
        fakeVscode.window.showWarningMessage = async (msg) => { warnCount++; lastWarningMsg = msg; return "Yes, deploy"; };
        await panel._runAction({
            env: "dev", actionMode: "validate", selectionMode: "files",
            files: ["force-app/main/default/classes/Obsolete.cls"], testMode: "auto",
        });
        check("deploy never runs when everything selected was a deletion", capturedSourceDirs === null);
        check("still tells the user why nothing happened", lastWarningMsg && (lastWarningMsg.includes("No files selected") || lastWarningMsg.includes("deleted file(s)")), lastWarningMsg);
    }

    // ---- 3. Mandatory promotion validate: a deleted file is excluded, story is warned, no crash ----
    {
        const config = require("../out/config.js");
        config.getSourceRootFolder = () => "force-app";
        config.getDeployTimeoutSeconds = () => 60;

        delete require.cache[require.resolve("../out/commands/promoteStory.js")];
        // runPromotionValidate isn't exported directly — exercised here through the exported
        // finalizeAndFinish, which calls it internally (same shape test_mandatory_validation.js uses).
        const { finalizeAndFinish } = require("../out/commands/promoteStory.js");
        config.findEnvironment = (name) => ({ name, label: name.toUpperCase(), branch: name, orgAlias: "QA-LIVE", deployTestLevel: "NoTestRun" });
        config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;

        lastWarningMsg = null; capturedSourceDirs = null;
        fakeVscode.window.showWarningMessage = async (msg) => { lastWarningMsg = msg; return undefined; };

        const gh = {
            promoBranchName: (storyId, env, mode) => `${mode}/${storyId}-to-${env}`,
            createLocalBranchFrom: async () => {},
            diffNameStatusBetween: async () => [
                { path: "force-app/main/default/classes/Foo.cls", change: "modified" },
                { path: "force-app/main/default/classes/Gone.cls", change: "deleted" },
            ],
            listFilesAtRef: async () => [],
            checkoutFeature: async () => {},
            appendAudit: async () => {},
            isPromotionValidated: async () => false,
            recordPromotionValidated: async () => {},
            getWorkspaceRoot: () => "/tmp",
        };

        await finalizeAndFinish({}, gh, "TEST-9", "qa", "validate", { refresh: () => {} });

        check("deleted file dropped from what's actually sent to the CLI", capturedSourceDirs && capturedSourceDirs.length === 1 && capturedSourceDirs[0] === "force-app/main/default/classes/Foo.cls", JSON.stringify(capturedSourceDirs));
        check("warns about the skipped deletion", lastWarningMsg && lastWarningMsg.includes("1 deleted file(s)") && lastWarningMsg.includes("Gone.cls"), lastWarningMsg);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
