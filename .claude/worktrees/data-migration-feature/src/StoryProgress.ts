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
 *   • every later environment, the pipeline within a single promotion:
 *       "none"           → nothing started yet.
 *       "branch-created" → the promotion branch exists but hasn't passed the MANDATORY
 *                          validate step yet (GitHelper.isPromotionValidated) — a PR
 *                          cannot be opened from here; see promoteStory.ts.
 *       "open"           → validated (or, with a provider token, actually confirmed as an
 *                          open PR) — merging it is the human review gate.
 *       "merged"         → the PR landed on the env's branch, but this extension hasn't
 *                          actually deployed that far yet.
 *       "deployed"       → a real deploy through the Deployment Dashboard has caught up to
 *                          (or passed) the story's commit.
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
            // This env has SOME commit for the story — but the feature branch may have moved
            // on since (another Commit & Publish landed new work on dev after this env was
            // already promoted through). Without this check, "Deployed"/"Merged" would keep
            // showing green forever, never prompting the story back through the pipeline for
            // its new content.
            if (!(await gitHelper.storyContentMatchesBranch(storyId, envBranch))) {
                return "none";
            }
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
            || await gitHelper.remoteBranchExists(validateBranch)) {
            // The branch existing is no longer enough to call this "open" — a PR can't
            // actually get opened until the mandatory validate step passes (see
            // promoteStory.ts). Without a provider token to check a real PR's state, this
            // is the best signal available: validated yet, or still sitting at step ②.
            return (await gitHelper.isPromotionValidated(storyId, env)) ? "open" : "branch-created";
        }
        return "none";
    } catch {
        return "unknown";
    }
}

/** One stage's real status, for the Story Progress accordion — "done" plus WHEN, or pending. */
export interface StageTimelineEntry {
    done: boolean;
    at?: string; // ISO timestamp
}

/**
 * The publish env (dev) only has Publish/Deploy; every later env has Validate/Promote/Deploy
 * — `published`/`validation`/`promotion` are only populated for the relevant kind of env,
 * `deployment` always is (Dev is independently deployable too, same as any other stage).
 */
export interface EnvTimeline {
    published?:  StageTimelineEntry;
    validation?: StageTimelineEntry;
    promotion?:  StageTimelineEntry;
    deployment:  StageTimelineEntry;
}

/**
 * Real timestamps behind each stage's icon in the pipeline accordion — reads the audit log
 * ONCE for every environment rather than per-call, since this runs on every refresh()
 * alongside getStoryProgress. Validate's timestamp comes from the dedicated
 * sf-devops-promotion-validation.json record (exact date it last passed, even if the gate
 * has since re-locked from new commits); Publish/Promote come from the audit trail (the
 * latest successful entry for that operation+story+env); Deploy comes from the same
 * deploy-state record getEnvState already uses to decide "deployed" vs "merged".
 */
export async function getStoryTimelines(
    gitHelper: GitHelper,
    storyId:   string
): Promise<Record<string, EnvTimeline>> {
    const timelines: Record<string, EnvTimeline> = {};
    if (!storyId) { return timelines; }

    const entries = await gitHelper.getAuditEntries();
    const latestEntry = (operation: string, env: string) => entries
        .filter(e => e.operation === operation && e.storyId === storyId && e.targetEnv === env && e.outcome === "success")
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
    // commitAndPublish entries never carry a targetEnv (submitForReview.ts records the
    // FEATURE branch instead, under `branch` — there's only ever one publish target, dev,
    // so there was nothing to disambiguate) — matching on operation+storyId alone.
    const latestPublishEntry = () => entries
        .filter(e => e.operation === "commitAndPublish" && e.storyId === storyId && e.outcome === "success")
        .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];

    const publishEnv = getPublishEnvironment();

    for (const envCfg of getEnvironments()) {
        const env = envCfg.name;
        const envBranch = envCfg.branch;

        let deployment: StageTimelineEntry = { done: false };
        try {
            const storyCommitSha = await gitHelper.storyCommitShaOnBranch(envBranch, storyId);
            if (storyCommitSha) {
                const lastDeploy = await gitHelper.getDeployState(env);
                if (lastDeploy && await gitHelper.isAncestorSha(storyCommitSha, lastDeploy.sha)) {
                    deployment = { done: true, at: lastDeploy.deployedAt };
                }
            }
        } catch { /* leave as pending */ }

        if (env === publishEnv.name) {
            const publishEntry = latestPublishEntry();
            timelines[env] = {
                published: publishEntry ? { done: true, at: publishEntry.timestamp } : { done: false },
                deployment,
            };
            continue;
        }

        let validation: StageTimelineEntry = { done: false };
        try {
            const record = await gitHelper.getPromotionValidationRecord(storyId, env);
            if (record?.passed) { validation = { done: true, at: record.date }; }
        } catch { /* leave as pending */ }

        const promoteEntry = latestEntry("promote", env);
        const promotion: StageTimelineEntry = promoteEntry ? { done: true, at: promoteEntry.timestamp } : { done: false };

        timelines[env] = { validation, promotion, deployment };
    }

    return timelines;
}
