const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. DeploymentEngine: fileName/lineNumber surfaced ----
    {
        const sfCli = require("../out/SfCli.js");
        sfCli.execSf = async () => ({
            stdout: JSON.stringify({ result: { id: "0Af1", status: "Failed", success: false, details: {
                componentFailures: [{ fullName: "Utils", componentType: "ApexClass", fileName: "classes/Utils.cls", lineNumber: 42, columnNumber: 7, problem: "Invalid type: Foo" }],
            } } }),
        });
        delete require.cache[require.resolve("../out/DeploymentEngine.js")];
        const { runDeploy } = require("../out/DeploymentEngine.js");
        const r = await runDeploy("/tmp", "force-app", [], "QA-LIVE", "RunLocalTests", 900, "deploy");
        check("componentFailures carries fileName/lineNumber/columnNumber", r.componentFailures[0].fileName === "classes/Utils.cls" && r.componentFailures[0].lineNumber === 42 && r.componentFailures[0].columnNumber === 7);
        check("error message includes file:line locator", r.error.includes("classes/Utils.cls:42:7"), r.error);
    }

    // ---- 2. _deriveCurrentStage carries orgAlias/isProd ----
    {
        const config = require("../out/config.js");
        config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev", orgAlias: "DEV-1", isProd: false });
        config.getPromotableEnvironments = () => [
            { name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE", isProd: false },
            { name: "prod", label: "PROD", branch: "main", orgAlias: "IB-LIVE", isProd: true },
        ];
        const { StoryWebviewProvider } = require("../out/providers/StoryWebviewProvider.js");
        const provider = Object.create(StoryWebviewProvider.prototype);

        const s1 = provider._deriveCurrentStage({ dev: "published", qa: "deployed", prod: "none" });
        check("stage carries orgAlias for next env", s1 && s1.orgAlias === "IB-LIVE" && s1.isProd === true, JSON.stringify(s1));

        const s2 = provider._deriveCurrentStage({ dev: "none" });
        check("dev stage carries its own orgAlias/isProd", s2 && s2.orgAlias === "DEV-1" && s2.isProd === false, JSON.stringify(s2));

        const s3 = provider._deriveCurrentStage({ dev: "published", qa: "deployed", prod: "deployed" });
        check("terminal state returns null", s3 === null);
    }

    // ---- 3. previewStoryFiles: real repo, no mutation ----
    {
        const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
        const WORKSPACE = process.env.SF_DEVOPS_TEST_REPO || "/Users/hardeepbrar/Documents/CODE/GitHub (Modular Projects)/Insurebridge-test";
        if (!require("fs").existsSync(WORKSPACE)) {
            console.log("SKIP — real-repo test: set SF_DEVOPS_TEST_REPO to a real Salesforce DX git repo to run this (see test/README.md).");
            process.exit(0);
        }
        fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: WORKSPACE } }];
        const cfgValues = { baseBranch: "main" };
        fakeVscode.workspace.getConfiguration = () => ({ get: (k, d) => (k in cfgValues ? cfgValues[k] : d) });

        delete require.cache[require.resolve("../out/GitHelper.js")];
        const { GitHelper } = require("../out/GitHelper.js");
        const gh = new GitHelper();

        const { execSync } = require("child_process");
        const branchBefore = execSync("git branch --show-current", { cwd: WORKSPACE }).toString().trim();
        const statusBefore = execSync("git status --porcelain", { cwd: WORKSPACE }).toString();

        const files = await gh.previewStoryFiles("TEST_2");
        console.log("  previewStoryFiles(TEST_2):", JSON.stringify(files));
        check("previewStoryFiles returns real files", Array.isArray(files) && files.length > 0);

        const branchAfter = execSync("git branch --show-current", { cwd: WORKSPACE }).toString().trim();
        const statusAfter = execSync("git status --porcelain", { cwd: WORKSPACE }).toString();
        check("no mutation: branch unchanged", branchBefore === branchAfter, `${branchBefore} -> ${branchAfter}`);
        check("no mutation: working tree unchanged", statusBefore === statusAfter);
    }

    // ---- 4. Promote confirm shows the file list before pushing anything ----
    {
        const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
        let lastWarningMsg = null;
        fakeVscode.window.showWarningMessage = async (msg) => { lastWarningMsg = msg; return undefined; }; // simulate Cancel
        fakeVscode.window.showInformationMessage = async () => undefined;

        const config = require("../out/config.js");
        config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa" }];
        config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
        config.findEnvironment = (name) => ({ name, label: name.toUpperCase(), branch: name });
        config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
        config.getCoverageGateEnvironment = () => undefined;

        delete require.cache[require.resolve("../out/commands/promoteStory.js")];
        const { runPromotion } = require("../out/commands/promoteStory.js");

        const fakeGitHelper = {
            tryBeginOperation: () => true,
            endOperation: () => {},
            currentBranch: async () => "feature/TEST-9",
            resolveRepoIdentity: async () => undefined,
            getPendingOperation: async () => null,
            checkoutBranch: async () => {},
            checkPrevEnvDeployed: async () => ({ blocked: false }),
            isSignoffPassed: async () => true,
            promotionBranchExists: async () => false,
            hasUncommittedChanges: async () => false,
            previewStoryFiles: async () => [
                { path: "force-app/main/default/classes/Foo.cls", change: "modified" },
                { path: "force-app/main/default/classes/Bar.cls", change: "added" },
            ],
        };
        const fakeStoryProvider = { refresh: () => {} };

        await runPromotion({ getOpenPRUrl: async () => null }, fakeGitHelper, "TEST-9", "qa", "promote", fakeStoryProvider);
        check("confirm dialog includes the file count", lastWarningMsg && lastWarningMsg.includes("2 file(s)"), lastWarningMsg);
        check("confirm dialog lists the actual paths", lastWarningMsg && lastWarningMsg.includes("Foo.cls") && lastWarningMsg.includes("Bar.cls"));

        // Nothing-to-promote case: should short-circuit with an info message, no warning dialog at all.
        lastWarningMsg = null;
        let infoMsg = null;
        fakeVscode.window.showInformationMessage = async (msg) => { infoMsg = msg; return undefined; };
        fakeGitHelper.previewStoryFiles = async () => [];
        await runPromotion({ getOpenPRUrl: async () => null }, fakeGitHelper, "TEST-9", "qa", "promote", fakeStoryProvider);
        check("nothing-to-promote short-circuits without a confirm dialog", lastWarningMsg === null && infoMsg && infoMsg.includes("nothing new to promote"), infoMsg);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
