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

const config = require("../out/config.js");
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", deployTestLevel: "RunLocalTests" }];
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
config.findEnvironment = (name) => config.getEnvironments().find(e => e.name === name);
config.getCoverageGateEnvironment = () => undefined;
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
config.featureBranchName = (id) => `feature/${id}`;

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function makeGitHelper(overrides) {
    return Object.assign({
        tryBeginOperation: () => true,
        endOperation: () => {},
        resolveRepoIdentity: async () => undefined,
        getPendingOperation: async () => null,
        checkPrevEnvDeployed: async () => ({ blocked: false }),
        isSignoffPassed: async () => true,
        promotionBranchExists: async () => false,
        previewStoryFiles: async () => [{ path: "force-app/main/default/classes/Foo.cls", change: "modified" }],
        currentBranch: async () => "feature/TEST-9",
        hasUncommittedChanges: async () => false,
        stagedFiles: async () => [],
        workingTreeFiles: async () => [],
        featureApexClasses: async () => [],
    }, overrides);
}

(async () => {
    const { runPromotion } = require("../out/commands/promoteStory.js");
    const bbClient = { getOpenPRUrl: async () => null };
    const storyProvider = { refresh: () => {} };

    // ---- 1. Confirm dialog always names the source explicitly ----
    {
        const gh = makeGitHelper({});
        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", storyProvider);
        check("confirm names the exact source branch", lastWarningMsg && lastWarningMsg.includes("Source: origin/feature/TEST-9"), lastWarningMsg);
        check("confirm explicitly rules out local files", lastWarningMsg && lastWarningMsg.includes("never your local uncommitted files"));
    }

    // ---- 2. ANY uncommitted changes anywhere -> hard block, same as Deploy's own guard ----
    // (Previously this only warned-and-continued when scoped to the feature branch; now it
    // hard-blocks unconditionally, matching DeploymentDashboardPanel's guard exactly, since
    // the underlying risk — a checkout colliding with dirty state — isn't scoped to just
    // that one branch either.)
    {
        const gh = makeGitHelper({
            hasUncommittedChanges: async () => true,
            stagedFiles: async () => ["force-app/main/default/classes/Bar.cls"],
            workingTreeFiles: async () => ["force-app/main/default/classes/Bar.cls", "force-app/main/default/classes/Baz.cls"],
        });
        let previewCalled = false;
        gh.previewStoryFiles = async () => { previewCalled = true; return []; };
        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", storyProvider);
        check("hard-blocks with a clear, actionable message", lastWarningMsg && lastWarningMsg.includes("Commit or stash your local changes"), lastWarningMsg);
        check("names the real reason (checkout would collide)", lastWarningMsg && lastWarningMsg.includes("collide"));
        check("stops before ever reaching the confirm/file-preview step", !previewCalled);
    }

    // ---- 3. Same hard block fires regardless of which branch has the uncommitted changes ----
    {
        const gh = makeGitHelper({
            currentBranch: async () => "main",
            hasUncommittedChanges: async () => true,
        });
        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", storyProvider);
        check("hard-blocks even when the dirty branch isn't the story's own feature branch", lastWarningMsg && lastWarningMsg.includes("Commit or stash your local changes"), lastWarningMsg);
    }

    // ---- 4. Deployment Dashboard pane labels its source explicitly ----
    {
        const { DeploymentDashboardPanel } = require("../out/providers/DeploymentDashboardPanel.js");
        const panel = Object.create(DeploymentDashboardPanel.prototype);
        panel._validatedSelections = new Map();
        const model = {
            env: { name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", isProd: false },
            groups: [], allFiles: [], apexTestMap: {}, apexTestFilePaths: {},
            canDeploy: true, orgAliasSet: true, lastDeploy: null, currentSha: null,
        };
        const html = panel._renderEnvPane(model);
        check("Dashboard pane explicitly labels its source as origin/<branch>", html.includes("origin/qa") && html.includes("pushed"), html.includes("origin/qa"));
        check("Dashboard pane explicitly rules out local working tree", html.includes("local working tree") || html.includes("never part of what gets"));
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
