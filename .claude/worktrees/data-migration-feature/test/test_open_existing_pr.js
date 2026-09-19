const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
let infoMsg = null;
let openedUrl = null;
fakeVscode.window.showInformationMessage = async (msg) => { infoMsg = msg; return undefined; };
// openExternal always opens the URI's own string form (a real https:// URL isn't a
// filesystem path — .fsPath is only meaningful for file:// URIs).
fakeVscode.env = { openExternal: (uri) => { openedUrl = uri.toString(); } };

const config = require("../out/config.js");
config.getPromotableEnvironments = () => [{ name: "qa", label: "QA", branch: "qa", orgAlias: "QA-LIVE" }];
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa" }];
config.findEnvironment = (name) => config.getEnvironments().find(e => e.name === name);
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
config.getCoverageGateEnvironment = () => undefined;

const { runPromotion } = require("../out/commands/promoteStory.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. Promote, with an already-open PR: jump straight to it, nothing else runs ----
    {
        let checkPrevCalled = false;
        const gh = {
            tryBeginOperation: () => true,
            endOperation: () => {},
            currentBranch: async () => "feature/TEST-9",
            resolveRepoIdentity: async () => undefined,
            getPendingOperation: async () => null,
            checkPrevEnvDeployed: async () => { checkPrevCalled = true; return { blocked: false }; },
        };
        let seenSource = null, seenDest = null;
        const bbClient = {
            getOpenPRUrl: async (source, dest) => {
                seenSource = source; seenDest = dest;
                return "https://github.com/acme/repo/pull/42";
            },
        };
        infoMsg = null; openedUrl = null;

        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", { refresh: () => {} });

        check("checks the promotion branch, not the feature branch", seenSource === "promote/TEST-9-to-qa", seenSource);
        check("checks against the target env's branch", seenDest === "qa", seenDest);
        check("opens the existing PR URL", openedUrl === "https://github.com/acme/repo/pull/42", openedUrl);
        check("tells the user what happened", infoMsg && infoMsg.includes("already has an open PR") && infoMsg.includes("QA"), infoMsg);
        check("never touches the rest of the pipeline (no gate checks, no lock)", !checkPrevCalled);
    }

    // ---- 2. No open PR: falls through to the normal flow (gate actually runs) ----
    {
        let checkPrevCalled = false;
        const gh = {
            tryBeginOperation: () => true,
            endOperation: () => {},
            currentBranch: async () => "feature/TEST-9",
            resolveRepoIdentity: async () => undefined,
            getPendingOperation: async () => null,
            checkPrevEnvDeployed: async () => { checkPrevCalled = true; return { blocked: false }; },
            hasUncommittedChanges: async () => false,
            promotionBranchExists: async () => false,
            previewStoryFiles: async () => [],
        };
        const bbClient = { getOpenPRUrl: async () => null };
        openedUrl = null;

        await runPromotion(bbClient, gh, "TEST-9", "qa", "promote", { refresh: () => {} });

        check("no PR to open — nothing opened in the browser", openedUrl === null);
    }

    // ---- 3. Validate Only never checks for an open PR (it doesn't deal in PRs) ----
    {
        let getOpenPRUrlCalled = false;
        const gh = {
            tryBeginOperation: () => true,
            endOperation: () => {},
            currentBranch: async () => "feature/TEST-9",
            resolveRepoIdentity: async () => undefined,
            getPendingOperation: async () => null,
            checkPrevEnvDeployed: async () => ({ blocked: false }),
            hasUncommittedChanges: async () => false,
            promotionBranchExists: async () => false,
        };
        const bbClient = { getOpenPRUrl: async () => { getOpenPRUrlCalled = true; return "https://example.com/should-not-be-used"; } };

        await runPromotion(bbClient, gh, "TEST-9", "qa", "validate", { refresh: () => {} });

        check("Validate Only skips the open-PR check entirely", !getOpenPRUrlCalled);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
