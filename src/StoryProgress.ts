// StoryProgress.ts — resolves a story's per-environment pipeline state (git-based, no
// token required). Extracted from StoryWebviewProvider so other callers (e.g. the "Start
// New Story" unfinished-work check) can reuse the exact same state resolution instead of
// duplicating it a third time.

import { GitHelper } from "./GitHelper";
import { IGitProviderClient } from "./GitProviderClient";
import { getEnvironments, getPublishEnvironment, promoBranchName } from "./config";

export async function getStoryProgress(
    gitHelper: GitHelper,
    bbClient:  IGitProviderClient,
    storyId:   string
): Promise<Record<string, string>> {
    const progress: Record<string, string> = {};

    // Refresh remote refs so detection sees the latest pushes/merges.
    await gitHelper.fetchRemote();

    for (const env of getEnvironments()) {
        progress[env.name] = await getEnvState(gitHelper, bbClient, storyId, env.name);
    }
    return progress;
}

/**
 * Resolves a story's state per environment (git-based, no token required).
 *   • the first configured environment (e.g. "dev") — "published" once the story's
 *     commit is on that environment's branch (published straight from the feature branch).
 *   • every later environment — "open" once its promotion/validate branch exists,
 *     "merged" once the PR has landed on the env's branch but this extension hasn't
 *     actually deployed that far yet, "deployed" once a real deploy through the
 *     Deployment Dashboard has caught up to (or passed) the story's commit, else "none".
 *     "merged" and "deployed" used to be the same state ("PR merged" was shown as
 *     "Deployed" outright) — that was wrong: merging a PR doesn't run `sf project
 *     deploy`, and conflating the two let the UI claim something was live in an org
 *     when nobody had actually deployed it there yet.
 */
export async function getEnvState(
    gitHelper: GitHelper,
    bbClient:  IGitProviderClient,
    storyId:   string,
    env:       string
): Promise<string> {
    if (!storyId) { return "none"; }
    try {
        const publishEnv = getPublishEnvironment();
        if (env === publishEnv.name) {
            return (await gitHelper.branchContainsStory(publishEnv.branch, storyId)) ? "published" : "none";
        }

        const envCfg           = getEnvironments().find(e => e.name === env);
        const envBranch        = envCfg?.branch ?? env;
        const promotionBranch  = promoBranchName(storyId, env, "promote");
        const validateBranch   = promoBranchName(storyId, env, "validate");

        const storyCommitSha = await gitHelper.storyCommitShaOnBranch(envBranch, storyId);
        if (storyCommitSha) {
            const lastDeploy = await gitHelper.getDeployState(env);
            if (lastDeploy && await gitHelper.isAncestorSha(storyCommitSha, lastDeploy.sha)) {
                return "deployed";
            }
            return "merged";
        }

        // A configured Bitbucket token can distinguish an open PR; otherwise use git.
        try {
            const api = await bbClient.getPRState(promotionBranch, envBranch);
            if (api === "merged") { return "merged"; }
            if (api === "open")   { return "open"; }
        } catch { /* no token — fall through */ }

        if (await gitHelper.remoteBranchExists(promotionBranch)
            || await gitHelper.remoteBranchExists(validateBranch)) { return "open"; }
        return "none";
    } catch {
        return "unknown";
    }
}
