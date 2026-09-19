const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

const fakeVscode = require(path.join(__dirname, "fake-vscode.js"));
const os = require("os");
const fs = require("fs");
const TMP_REPO = fs.mkdtempSync(path.join(os.tmpdir(), "sfdevops-test-"));
fakeVscode.workspace.workspaceFolders = [{ uri: { fsPath: TMP_REPO } }];
fakeVscode.workspace.getConfiguration = () => ({ get: () => undefined });

const { execSync } = require("child_process");
execSync("git init -q -b main", { cwd: TMP_REPO });
execSync("git config user.email test@test.com && git config user.name Test", { cwd: TMP_REPO });
fs.mkdirSync(path.join(TMP_REPO, ".git"), { recursive: true });

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

const config = require("../out/config.js");
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;
config.getPromotionBranchTemplate = () => "promotion/{storyId}-to-{env}";

const { GitHelper } = require("../out/GitHelper.js");
const gh = new GitHelper();

// Stub remoteHeadSha since there's no real origin remote in this throwaway repo — simulate
// a promotion branch sitting at "shaA" initially, then moving to "shaB".
let currentSha = "shaA";
gh.remoteHeadSha = async (branch) => (branch === "promote/TEST-1-to-qa" ? currentSha : null);

(async () => {
    // ---- isPromotionValidated / recordPromotionValidated: sha-fingerprint lock ----
    check("not validated before any record exists", !(await gh.isPromotionValidated("TEST-1", "qa")));

    await gh.recordPromotionValidated("TEST-1", "qa", { numberComponentsDeployed: 2 });
    check("validated immediately after recording (same sha)", await gh.isPromotionValidated("TEST-1", "qa"));

    currentSha = "shaB"; // branch moved — new commit, e.g. a re-run of beginPromotion
    check("re-locks the instant the branch moves to a new sha", !(await gh.isPromotionValidated("TEST-1", "qa")));

    await gh.recordPromotionValidated("TEST-1", "qa", {});
    check("re-validating at the new sha passes again", await gh.isPromotionValidated("TEST-1", "qa"));

    // A different env/story must be tracked independently.
    check("different env is independently unvalidated", !(await gh.isPromotionValidated("TEST-1", "uat")));

    // ---- syncLocalRef: never throws, no-ops cleanly when there's nothing to sync ----
    try {
        await gh.syncLocalRef("nonexistent-branch");
        check("syncLocalRef on a branch with no local copy doesn't throw", true);
    } catch (e) {
        check("syncLocalRef on a branch with no local copy doesn't throw", false, e.message);
    }

    // ---- syncLocalPromotionBranches: never throws even with zero matching branches ----
    try {
        await gh.syncLocalPromotionBranches();
        check("syncLocalPromotionBranches doesn't throw with no promotion branches", true);
    } catch (e) {
        check("syncLocalPromotionBranches doesn't throw with no promotion branches", false, e.message);
    }

    // ---- deletePromotionBranch: best-effort, never throws even when nothing exists ----
    try {
        await gh.deletePromotionBranch("TEST-1", "qa");
        check("deletePromotionBranch on a nonexistent branch doesn't throw", true);
    } catch (e) {
        check("deletePromotionBranch on a nonexistent branch doesn't throw", false, e.message);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    fs.rmSync(TMP_REPO, { recursive: true, force: true });
    process.exit(allPass ? 0 : 1);
})();
