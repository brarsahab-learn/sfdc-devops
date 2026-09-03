const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. GitHelper.createEnvBranchOnOrigin: pure ref-to-ref push, no local checkout ----
    {
        const { GitHelper } = require("../out/GitHelper.js");
        const config = require("../out/config.js");
        config.getBaseBranch = () => "main";

        const gh = Object.create(GitHelper.prototype);
        const calls = [];
        gh.git = async (args) => { calls.push(args.join(" ")); return ""; };
        gh.remoteBranchExists = async (ref) => ref === "main";

        await gh.createEnvBranchOnOrigin("qa");
        check("fetches first", calls[0] === "fetch origin --prune", calls[0]);
        check("pushes origin/main straight onto refs/heads/qa — no checkout at all", calls.includes("push origin origin/main:refs/heads/qa"), JSON.stringify(calls));
        check("never runs a checkout", !calls.some(c => c.startsWith("checkout")), JSON.stringify(calls));
    }

    // ---- 2. Fails clearly when the base branch itself doesn't exist on origin either ----
    {
        const { GitHelper } = require("../out/GitHelper.js");
        const gh = Object.create(GitHelper.prototype);
        gh.git = async () => "";
        gh.remoteBranchExists = async () => false;
        let threw = null;
        try { await gh.createEnvBranchOnOrigin("qa"); } catch (e) { threw = e; }
        check("throws a clear error instead of a confusing git failure", threw && String(threw).includes("origin/main"), String(threw));
    }

    // ---- 3. Setup Check surfaces missingEnvBranches for the UI to act on ----
    {
        delete require.cache[require.resolve("../out/SetupCheck.js")];
        const config = require("../out/config.js");
        config.getBaseBranch = () => "main";
        config.getEnvironments = () => [
            { name: "dev", label: "DEV", branch: "dev" },
            { name: "qa", label: "QA", branch: "qa" },
        ];
        config.getSourceRootFolder = () => "force-app";
        config.getRepoWorkspace = () => "";
        config.getRepoSlug = () => "";
        config.getOrgAliasSlots = () => [];

        fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: "/tmp/repo" } }];
        const { runSetupChecks } = require("../out/SetupCheck.js");

        const gh = {
            currentBranch: async () => "feature/TEST-1",
            fetchRemote: async () => {},
            getWorkspaceRoot: () => "/tmp/repo",
            remoteBranchExists: async (ref) => ref === "main" || ref === "dev", // qa missing
            getRemoteUrl: async () => "https://github.com/acme/repo.git",
        };
        const bbClient = { providerName: "github", parseRemoteUrl: () => ({ workspace: "acme", repoSlug: "repo" }) };
        const context = { secrets: { get: async () => undefined } };

        const checks = await runSetupChecks(gh, bbClient, context);
        const item = checks.find(c => c.key === "environmentBranches");
        check("environmentBranches check ran", Boolean(item));
        check("only the actually-missing branch is listed", item.missingEnvBranches.length === 1 && item.missingEnvBranches[0].branch === "qa", JSON.stringify(item.missingEnvBranches));
        check("carries the env's label too, for the button text", item.missingEnvBranches[0].label === "QA", JSON.stringify(item.missingEnvBranches));
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
