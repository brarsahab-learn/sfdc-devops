const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));

const events = [];
fakeVscode.window.showInformationMessage = async (msg, ...actions) => {
    if (actions.length > 0) {
        // The cleanup prompt — simulate it sitting unanswered for a bit, exactly the
        // "easy to miss" scenario that made the deploy notification look stuck.
        events.push("cleanup-prompt-shown");
        await new Promise(r => setTimeout(r, 20));
        events.push("cleanup-prompt-answered");
        return "No";
    }
    events.push("info:" + msg.slice(0, 20));
    return undefined;
};
fakeVscode.window.showWarningMessage = async () => "Yes, deploy";

let withProgressResolvedAt = null;
fakeVscode.window.withProgress = async (opts, task) => {
    const result = await task({ report: () => {} });
    withProgressResolvedAt = events.length; // snapshot of what had happened by the time withProgress itself resolves
    events.push("withProgress-resolved");
    return result;
};
fakeVscode.ProgressLocation = { Notification: 1 };

const config = require("../out/config.js");
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1" });
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", isProd: false, orgAlias: "QA-LIVE" }];
config.canPromote = () => true;

const deployEngine = require("../out/DeploymentEngine.js");
deployEngine.runDeploy = async () => ({ ran: true, success: true, numberComponentsDeployed: 1 });

const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    const panel = Object.create(DeploymentDashboardPanel.prototype);
    panel._validatedSelections = new Map();
    panel._lastOutcome = undefined;
    panel._extContext = { globalState: { get: () => "Admin" } };
    panel.refresh = async () => {};
    const env = { name: "qa", label: "QA", branch: "qa", isProd: false, orgAlias: "QA-LIVE", deployTestLevel: "NoTestRun" };
    const model = {
        env, groups: [{ storyId: "TEST-9", files: [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }] }],
        apexTestMap: {}, apexTestFilePaths: {}, canDeploy: true, orgAliasSet: true,
        allFiles: [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
    };
    panel._buildViewModel = async () => model;
    panel._gitHelper = {
        tryBeginOperation: () => true,
        endOperation: () => {},
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        hasUncommittedChanges: async () => false,
        createLocalBranchFrom: async () => {},
        currentBranch: async () => "main",
        checkoutBranch: async () => {},
        remoteHeadSha: async () => null,
        appendAudit: async () => {},
        getWorkspaceRoot: () => "/tmp",
        remoteBranchExists: async () => true,
        promoBranchName: (id, env) => `promote/${id}-to-${env}`,
        deletePromotionBranch: async () => {},
    };

    // Deploy directly (mode: deploy) — nothing that already exists is validated first here,
    // hence the deploy-lock check being irrelevant to this test; the point is purely
    // sequencing of the progress notification vs. the follow-up cleanup prompt.
    panel._validatedSelections.set("qa", "force-app/main/default/classes/Foo.cls");
    await panel._runAction({
        env: "qa", actionMode: "deploy", selectionMode: "files",
        files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto",
    });

    check("cleanup prompt was shown at all", events.includes("cleanup-prompt-shown"), JSON.stringify(events));
    check(
        "the progress notification resolved BEFORE the cleanup prompt was even shown (not blocked by it)",
        events.indexOf("withProgress-resolved") < events.indexOf("cleanup-prompt-shown"),
        JSON.stringify(events)
    );

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
