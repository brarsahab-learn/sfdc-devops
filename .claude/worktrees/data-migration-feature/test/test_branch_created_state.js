const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

const config = require("../out/config.js");
config.getEnvironments = () => [{ name: "dev", label: "Dev", branch: "dev" }, { name: "qa", label: "QA", branch: "qa", requiredRole: undefined }];
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev" });
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;

const { getEnvState } = require("../out/StoryProgress.js");
const bbClient = { getPRState: async () => { throw new Error("no token"); } };

(async () => {
    // ---- branch exists, not validated -> "branch-created" ----
    {
        const gh = {
            branchContainsStory: async () => false,
            storyCommitShaOnBranch: async () => null,
            remoteBranchExists: async (b) => b === "promote/TEST-1-to-qa",
            isPromotionValidated: async () => false,
        };
        const state = await getEnvState(gh, bbClient, "TEST-1", "qa");
        check("branch exists + not validated => 'branch-created'", state === "branch-created", state);
    }

    // ---- branch exists, validated -> "open" ----
    {
        const gh = {
            branchContainsStory: async () => false,
            storyCommitShaOnBranch: async () => null,
            remoteBranchExists: async (b) => b === "promote/TEST-1-to-qa",
            isPromotionValidated: async () => true,
        };
        const state = await getEnvState(gh, bbClient, "TEST-1", "qa");
        check("branch exists + validated => 'open'", state === "open", state);
    }

    // ---- no branch at all -> "none" ----
    {
        const gh = {
            branchContainsStory: async () => false,
            storyCommitShaOnBranch: async () => null,
            remoteBranchExists: async () => false,
            isPromotionValidated: async () => false,
        };
        const state = await getEnvState(gh, bbClient, "TEST-1", "qa");
        check("no branch => 'none'", state === "none", state);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
