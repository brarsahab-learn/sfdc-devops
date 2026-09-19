const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const config = require("../out/config.js");
config.getEnvironments = () => [
    { name: "dev", label: "Dev", branch: "dev", isProd: false },
    { name: "qa", label: "QA", branch: "qa", isProd: false },
    { name: "uat", label: "UAT", branch: "uat", isProd: false },
];
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev" });
config.getPromotableEnvironments = () => [
    { name: "qa", label: "QA", branch: "qa", isProd: false },
    { name: "uat", label: "UAT", branch: "uat", isProd: false },
];
config.getCoverageGateEnvironment = () => undefined;
config.getCurrentRole = () => "Admin";
config.getFallbackRefreshSeconds = () => 180;

const { StoryWebviewProvider } = require("../out/providers/StoryWebviewProvider.js");
const { GitHelper } = require("../out/GitHelper.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

function makeProvider(statusCb) {
    const p = Object.create(StoryWebviewProvider.prototype);
    p._bbClient = { buildPrUrl: () => null };
    p._extContext = {
        extension: { packageJSON: { version: "3.14.0" } },
        globalState: { get: () => undefined, update: async () => undefined },
        workspaceState: { get: () => true, update: async () => undefined },
    };
    p._forceShowSetup = false;
    p._onStatusChange = statusCb;
    return p;
}

(async () => {
    // ---- 1. Expandable file list rendering ----
    {
        const provider = makeProvider();
        const progress = { dev: "published", qa: "none", uat: "none" };
        const localChanges = { staged: ["force-app/main/default/classes/Foo.cls"], other: ["force-app/main/default/classes/Bar.cls"] };
        const html = provider._getWebviewHtml("feature/TEST-1", "TEST-1", progress, 0, undefined, undefined, {}, localChanges, {});
        check("expandable <details> present", html.includes('class="changed-files"'));
        check("staged file path rendered", html.includes("viewWorkingDiff('force-app/main/default/classes/Foo.cls')"));
        check("unstaged file path rendered", html.includes("viewWorkingDiff('force-app/main/default/classes/Bar.cls')"));
        check("staged/unstaged badges present", html.includes(">staged<") && html.includes(">unstaged<"));
    }

    // ---- 2. Busy bar present in all 3 templates ----
    {
        const provider = makeProvider();
        const mainHtml = provider._getWebviewHtml("feature/TEST-1", "TEST-1", { dev: "published", qa: "none", uat: "none" }, 0, undefined, undefined, {}, null, {});
        check("main template: busy bar + showBusy wired", mainHtml.includes('id="busyBar"') && mainHtml.includes("function showBusy()") && mainHtml.includes("showBusy(); vscode.postMessage"));

        const checks = [{ key: "gitRepo", label: "Git", detail: "ok", passed: true, required: true, fixSteps: [] }];
        const setupHtml = provider._getSetupGateHtml(checks, true, true);
        check("setup gate template: busy bar wired", setupHtml.includes('id="busyBar"') && setupHtml.includes("function showBusy()"));

        const conflictHtml = provider._getConflictHtml({ storyId: "TEST-1", kind: "promote", targetEnv: "qa", mode: "promote" }, ["Foo.cls"]);
        check("conflict template: busy bar wired", conflictHtml.includes('id="busyBar"') && conflictHtml.includes("function showBusy()"));
    }

    // ---- 3. External-switch notice: two refresh() calls, real GitHelper w/ stubbed currentBranch ----
    {
        const gh = Object.create(GitHelper.prototype);
        let branch = "feature/TEST-1";
        gh.currentBranch = async () => branch;
        gh.isRecentSelfInitiatedSwitch = () => false;
        gh.getPendingOperation = async () => null;
        gh.commitsBehind = async () => 0;
        gh.stagedFiles = async () => [];
        gh.workingTreeFiles = async () => [];
        gh.isSignoffPassed = async () => true;
        gh.resolveRepoIdentity = async () => undefined;

        const provider = makeProvider();
        provider._gitHelper = gh;
        provider._view = { visible: true };
        provider._getCoverageBlockedEnv = async () => null;
        // Stub the setup-check dependency indirectly isn't possible without more plumbing —
        // instead call the private detection method directly, which is what actually matters here.
        check("no notice on first-ever call (nothing to compare against)", (() => {
            provider._noteBranchForExternalSwitchDetection(branch);
            return provider._externalSwitchNotice === undefined;
        })());

        branch = "feature/TEST-2";
        provider._noteBranchForExternalSwitchDetection(branch);
        check("notice fires on a real external branch change", typeof provider._externalSwitchNotice === "string" && provider._externalSwitchNotice.includes("TEST-2"));

        // Self-initiated: same transition, but flagged as caused by our own checkout.
        provider._externalSwitchNotice = undefined;
        provider._lastKnownBranch = "feature/TEST-2";
        gh.isRecentSelfInitiatedSwitch = () => true;
        branch = "feature/TEST-3";
        provider._noteBranchForExternalSwitchDetection(branch);
        check("no notice when the switch was self-initiated", provider._externalSwitchNotice === undefined);
    }

    // ---- 4. _deriveCurrentStage ----
    {
        const provider = makeProvider();
        check("stage: dev not yet published", provider._deriveCurrentStage({ dev: "none" })?.label === "Dev");
        check("stage: qa next", provider._deriveCurrentStage({ dev: "published", qa: "open", uat: "none" })?.label === "QA");
        check("stage: terminal (null)", provider._deriveCurrentStage({ dev: "published", qa: "deployed", uat: "deployed" }) === null);
    }

    // ---- 5. GitWatcher degrades gracefully with no vscode.git extension ----
    {
        const { watchGitState } = require("../out/GitWatcher.js");
        try {
            const d = watchGitState("/tmp/whatever", () => {});
            check("watchGitState returns a disposable without throwing", typeof d.dispose === "function");
            d.dispose();
            check("dispose() doesn't throw", true);
        } catch (e) {
            check("watchGitState returns a disposable without throwing", false, e.stack);
        }
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
