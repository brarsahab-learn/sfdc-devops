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

const config = require("../out/config.js");
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1" });
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", isProd: false }];
config.canPromote = () => true;

const deployEngine = require("../out/DeploymentEngine.js");
let capturedSourceDirs = null;
deployEngine.runDeploy = async (workspaceRoot, sourceRoot, sourceDirs) => {
    capturedSourceDirs = sourceDirs;
    return { ran: true, success: true, numberComponentsDeployed: sourceDirs.length };
};

const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. Server-side fold-in: selecting Foo.cls alone still deploys its -meta.xml too ----
    {
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        panel._lastOutcome = undefined;
        panel._extContext = { globalState: { get: () => "Admin" } };
        panel.refresh = async () => {};
        const env = { name: "dev", label: "Dev", branch: "dev", isProd: false, orgAlias: "ib@dev1", deployTestLevel: "NoTestRun" };
        const model = {
            env, groups: [], allFiles: [
                { path: "force-app/main/default/classes/Foo.cls", change: "modified" },
                { path: "force-app/main/default/classes/Foo.cls-meta.xml", change: "modified" },
            ],
            apexTestMap: {}, apexTestFilePaths: {},
            canDeploy: true, orgAliasSet: true,
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

        capturedSourceDirs = null;
        await panel._runAction({
            env: "dev", actionMode: "validate", selectionMode: "files",
            files: ["force-app/main/default/classes/Foo.cls"], testMode: "auto",
        });
        check("meta.xml sibling folded in even though only the .cls was in the selection",
            capturedSourceDirs && capturedSourceDirs.length === 2 && capturedSourceDirs.includes("force-app/main/default/classes/Foo.cls-meta.xml"),
            JSON.stringify(capturedSourceDirs));
    }

    // ---- 2. Rendered rows carry data-name/data-date, and meta rows are tagged for hiding ----
    {
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        const model = {
            env: { name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", isProd: false },
            groups: [], apexTestMap: {}, apexTestFilePaths: {},
            canDeploy: true, orgAliasSet: true, lastDeploy: null, currentSha: null,
            packageXml: "<xml/>", unmapped: [],
            allFiles: [
                { path: "force-app/main/default/classes/Foo.cls", change: "modified" },
                { path: "force-app/main/default/classes/Foo.cls-meta.xml", change: "modified" },
            ],
            fileDates: {
                "force-app/main/default/classes/Foo.cls": "2026-08-01T00:00:00.000Z",
                "force-app/main/default/classes/Foo.cls-meta.xml": "2026-08-01T00:00:00.000Z",
            },
        };
        const html = panel._renderEnvPane(model);
        check("meta.xml row is tagged with the meta-file class", /class="tree-row meta-file"[^>]*value="[^"]*Foo\.cls-meta\.xml/.test(html.replace(/\n/g, "")) || html.includes('meta-file" data-env="qa" data-stories="" data-name="Foo.cls-meta.xml"'));
        check("non-meta row carries data-date", html.includes('data-date="2026-08-01T00:00:00.000Z"'));
        check("toggleFile is wired with the checkbox element (this), not just the env", html.includes("onchange=\"toggleFile('qa', this)\""));
        check("Show meta files checkbox present, and tree defaults to hide-meta", html.includes('id="showMeta-qa"') && html.includes('class="tree hide-meta"'));
        check("Sort dropdown present with Name/Date updated options", html.includes('class="sort-select" data-env="qa"') && html.includes('value="date">Date updated'));
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
