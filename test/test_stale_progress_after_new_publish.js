const Module = require("module");
const path = require("path");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === "vscode") { return path.join(__dirname, "fake-vscode.js"); }
    return origResolve.call(this, request, ...args);
};
require(path.join(__dirname, "fake-vscode.js"));

const config = require("../out/config.js");
config.getPublishEnvironment = () => ({ name: "dev", label: "Dev", branch: "dev" });
config.getEnvironments = () => [
    { name: "dev", label: "Dev", branch: "dev" },
    { name: "qa", label: "QA", branch: "qa" },
];
config.promoBranchName = (storyId, env, mode) => `${mode}/${storyId}-to-${env}`;

const { getEnvState } = require("../out/StoryProgress.js");

let allPass = true;
function check(name, cond, extra) { console.log(`${cond ? "PASS" : "FAIL"}: ${name}${extra ? " — " + extra : ""}`); if (!cond) allPass = false; }

(async () => {
    // ---- 1. QA already "deployed" for an OLD commit, but dev has NEW unpromoted content -> reverts to "none" ----
    {
        const gh = {
            storyCommitShaOnBranch: async (branch) => branch === "qa" ? "old-sha-on-qa" : null,
            storyContentMatchesBranch: async (storyId, envBranch) => envBranch !== "qa", // qa is stale, everything else "matches" (trivially true)
            getDeployState: async () => ({ sha: "old-sha-on-qa", deployedAt: "2026-09-02T00:00:00Z" }),
            isAncestorSha: async () => true,
            remoteBranchExists: async () => false,
            isPromotionValidated: async () => true,
        };
        const state = await getEnvState(gh, {}, "TEST3", "qa");
        check("QA reverts to 'none' once dev has new, unpromoted content — not stuck showing stale 'deployed'", state === "none", state);
    }

    // ---- 2. QA is genuinely up to date (dev has nothing new beyond what QA already has) -> stays "deployed" ----
    {
        const gh = {
            storyCommitShaOnBranch: async (branch) => branch === "qa" ? "current-sha-on-qa" : null,
            storyContentMatchesBranch: async () => true, // nothing has drifted
            getDeployState: async () => ({ sha: "current-sha-on-qa", deployedAt: "2026-09-02T00:00:00Z" }),
            isAncestorSha: async () => true,
            remoteBranchExists: async () => false,
            isPromotionValidated: async () => true,
        };
        const state = await getEnvState(gh, {}, "TEST3", "qa");
        check("QA stays 'deployed' when there's genuinely nothing new to promote", state === "deployed", state);
    }

    // ---- 3. Same staleness check applies to the "merged but not yet deployed" case ----
    {
        const gh = {
            storyCommitShaOnBranch: async (branch) => branch === "qa" ? "old-sha-on-qa" : null,
            storyContentMatchesBranch: async (storyId, envBranch) => envBranch !== "qa",
            getDeployState: async () => null, // never deployed from this dashboard
            isAncestorSha: async () => false,
            remoteBranchExists: async () => false,
            isPromotionValidated: async () => true,
        };
        const state = await getEnvState(gh, {}, "TEST3", "qa");
        check("stale 'merged' also reverts to 'none' instead of hiding the new work", state === "none", state);
    }

    console.log(allPass ? "\nALL PASS" : "\nSOME FAILED");
    process.exit(allPass ? 0 : 1);
})();
