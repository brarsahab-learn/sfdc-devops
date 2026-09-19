const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
fakeVscode.window.showWarningMessage = async () => "Yes, deploy";
fakeVscode.window.showInformationMessage = async () => undefined;
fakeVscode.window.showErrorMessage = async () => undefined;
fakeVscode.window.withProgress = async (opts, task) => task({ report: () => {} });
fakeVscode.ProgressLocation = { Notification: 1 };

const config = require("../out/config.js");
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1" });
config.getPromotableEnvironments = () => [{ name: "prod", label: "PROD", branch: "main", isProd: true, orgAlias: "ib@prod", deployTestLevel: "NoTestRun" }];
config.canPromote = () => true;

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function makeProdModel() {
    const env = { name: "prod", label: "PROD", branch: "main", isProd: true, orgAlias: "ib@prod", deployTestLevel: "NoTestRun" };
    return {
        env, groups: [{ storyId: "TEST-9", files: [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }] }],
        apexTestMap: {}, apexTestFilePaths: {}, canDeploy: true, orgAliasSet: true,
        allFiles: [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
    };
}

function makeGitHelper() {
    return {
        tryBeginOperation: () => true,
        endOperation: () => {},
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        hasUncommittedChanges: async () => false,
        createLocalBranchFrom: async () => {},
        currentBranch: async () => "main",
        checkoutBranch: async () => {},
        remoteHeadSha: async () => "sha1",
        recordDeployed: async () => {},
        appendAudit: async () => {},
        getWorkspaceRoot: () => "/tmp",
        remoteBranchExists: async () => false,
        promoBranchName: (id, env, mode) => `${mode}/${id}-to-${env}`,
    };
}

(async () => {
    // ---- 1. getDemoOrgAlias/setDemoOrgAlias round-trip through the same store dev/prod use ----
    {
        const store = {};
        fakeVscode._extContextForConfig = undefined;
        // config.ts's readOrgAliases/writeOrgAlias are keyed off an internal _extContext set via
        // initOrgAliasStore — simulate that exactly the way dev/prod aliases already rely on it.
        // Org aliases now live in workspaceState (migrated from globalState — see
        // _migrateOrgAliasesIfNeeded, which also touches workspaceState directly, so both
        // the alias data itself and the "already migrated" flag need a real store here).
        const migratedFlag = { value: undefined };
        const fakeContext = {
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: {
                get: (key) => (key === "sfDevops.orgAliases" ? store.data : key === "sfDevops.orgAliasesMigrated" ? migratedFlag.value : undefined),
                update: async (key, value) => {
                    if (key === "sfDevops.orgAliases") { store.data = value; }
                    else if (key === "sfDevops.orgAliasesMigrated") { migratedFlag.value = value; }
                },
            },
        };
        config.initOrgAliasStore(fakeContext);

        check("no alias set initially", config.getDemoOrgAlias() === "", config.getDemoOrgAlias());
        await config.setDemoOrgAlias("ib@demo1");
        check("getDemoOrgAlias reads back what setDemoOrgAlias wrote", config.getDemoOrgAlias() === "ib@demo1", config.getDemoOrgAlias());
        check("stored in the SAME org-alias store dev/prod use (not a separate key)", store.data && store.data.demo === "ib@demo1", JSON.stringify(store.data));
    }

    // ---- 2. Dashboard: Demo checkbox only renders on the Prod pane, only when configured ----
    {
        const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();

        // No demo alias configured — must not appear even on Prod.
        await config.setDemoOrgAlias("");
        let html = panel._renderEnvPane(Object.assign(makeProdModel(), { fileDates: {}, packageXml: "<xml/>", unmapped: [], lastDeploy: null, currentSha: null }));
        check("no Demo checkbox when no Demo alias is configured", !html.includes("deployToDemo-"), html.includes("deployToDemo-"));

        await config.setDemoOrgAlias("ib@demo1");
        html = panel._renderEnvPane(Object.assign(makeProdModel(), { fileDates: {}, packageXml: "<xml/>", unmapped: [], lastDeploy: null, currentSha: null }));
        check("Demo checkbox appears on the Prod pane once configured", html.includes('id="deployToDemo-prod"'), html.includes('id="deployToDemo-prod"'));
        check("checkbox label names the actual alias", html.includes("ib@demo1"), html.includes("ib@demo1"));

        // A non-prod env must never show it, even with a Demo alias configured.
        const qaModel = Object.assign(makeProdModel(), { fileDates: {}, packageXml: "<xml/>", unmapped: [], lastDeploy: null, currentSha: null });
        qaModel.env = { name: "qa", label: "QA", branch: "qa", isProd: false, orgAlias: "ib@qa", deployTestLevel: "NoTestRun" };
        const qaHtml = panel._renderEnvPane(qaModel);
        check("non-Prod env never shows the Demo checkbox", !qaHtml.includes("deployToDemo-"), qaHtml.includes("deployToDemo-"));
    }

    // ---- 3. _runAction: checkbox checked -> both deploys run, genuinely overlapping, same files/testLevel ----
    {
        await config.setDemoOrgAlias("ib@demo1");
        const deployEngine = require("../out/DeploymentEngine.js");
        const calls = [];
        deployEngine.runDeploy = async (workspaceRoot, sourceRoot, sourceDirs, orgAlias, testLevel, timeout, mode, tests, onProgress) => {
            const call = { orgAlias, sourceDirs: sourceDirs.slice(), testLevel, startedAt: Date.now() };
            calls.push(call);
            onProgress && onProgress(`in progress for ${orgAlias}`);
            await new Promise(r => setTimeout(r, 40)); // long enough that a SEQUENTIAL run would visibly not overlap
            call.finishedAt = Date.now();
            return { ran: true, success: true, numberComponentsDeployed: sourceDirs.length };
        };

        const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        panel._lastOutcome = undefined;
        panel._extContext = { globalState: { get: () => "Admin" } };
        panel.refresh = async () => {};
        const model = Object.assign(makeProdModel(), { fileDates: {}, packageXml: "<xml/>", unmapped: [], lastDeploy: null, currentSha: null });
        panel._buildViewModel = async () => model;
        panel._gitHelper = makeGitHelper();

        panel._validatedSelections.set("prod", "force-app/main/default/classes/Foo.cls");
        await panel._runAction({
            env: "prod", actionMode: "deploy", selectionMode: "files",
            files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto", deployToDemo: true,
        });

        check("exactly 2 deploys ran (Prod + Demo)", calls.length === 2, calls.length);
        const prodCall = calls.find(c => c.orgAlias === "ib@prod");
        const demoCall = calls.find(c => c.orgAlias === "ib@demo1");
        check("Prod deploy actually ran", Boolean(prodCall));
        check("Demo deploy actually ran", Boolean(demoCall));
        check("Demo got the SAME file selection as Prod", demoCall && JSON.stringify(demoCall.sourceDirs) === JSON.stringify(prodCall.sourceDirs), demoCall && JSON.stringify(demoCall.sourceDirs));
        check("Demo got the SAME test level as Prod", demoCall && demoCall.testLevel === prodCall.testLevel, demoCall && demoCall.testLevel);
        check(
            "the two deploys genuinely overlapped in time (concurrent, not sequential)",
            prodCall && demoCall && prodCall.startedAt < demoCall.finishedAt && demoCall.startedAt < prodCall.finishedAt,
            JSON.stringify({ prodCall, demoCall })
        );
    }

    // ---- 4. Checkbox unchecked -> only Prod deploys, no Demo call at all ----
    {
        await config.setDemoOrgAlias("ib@demo1");
        const deployEngine = require("../out/DeploymentEngine.js");
        const calls = [];
        deployEngine.runDeploy = async (workspaceRoot, sourceRoot, sourceDirs, orgAlias) => {
            calls.push(orgAlias);
            return { ran: true, success: true, numberComponentsDeployed: sourceDirs.length };
        };

        const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        panel._extContext = { globalState: { get: () => "Admin" } };
        panel.refresh = async () => {};
        const model = Object.assign(makeProdModel(), { fileDates: {}, packageXml: "<xml/>", unmapped: [], lastDeploy: null, currentSha: null });
        panel._buildViewModel = async () => model;
        panel._gitHelper = makeGitHelper();

        panel._validatedSelections.set("prod", "force-app/main/default/classes/Foo.cls");
        await panel._runAction({
            env: "prod", actionMode: "deploy", selectionMode: "files",
            files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto", deployToDemo: false,
        });

        check("only Prod deployed — no Demo call when the checkbox is unchecked", calls.length === 1 && calls[0] === "ib@prod", JSON.stringify(calls));
    }

    // ---- 5. A Demo failure doesn't affect Prod's own outcome/recordDeployed, and vice versa ----
    {
        await config.setDemoOrgAlias("ib@demo1");
        const deployEngine = require("../out/DeploymentEngine.js");
        deployEngine.runDeploy = async (workspaceRoot, sourceRoot, sourceDirs, orgAlias) => {
            if (orgAlias === "ib@demo1") { return { ran: true, success: false, error: "Demo org broke" }; }
            return { ran: true, success: true, numberComponentsDeployed: sourceDirs.length };
        };

        const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        panel._extContext = { globalState: { get: () => "Admin" } };
        panel.refresh = async () => {};
        const model = Object.assign(makeProdModel(), { fileDates: {}, packageXml: "<xml/>", unmapped: [], lastDeploy: null, currentSha: null });
        panel._buildViewModel = async () => model;
        let recordDeployedCalls = 0;
        panel._gitHelper = Object.assign(makeGitHelper(), { recordDeployed: async () => { recordDeployedCalls++; } });

        panel._validatedSelections.set("prod", "force-app/main/default/classes/Foo.cls");
        await panel._runAction({
            env: "prod", actionMode: "deploy", selectionMode: "files",
            files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto", deployToDemo: true,
        });

        check("Prod still recorded as deployed even though Demo failed", recordDeployedCalls === 1, recordDeployedCalls);
        check("Prod's own selection lock was cleared (Prod succeeded)", !panel._validatedSelections.has("prod"));
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
