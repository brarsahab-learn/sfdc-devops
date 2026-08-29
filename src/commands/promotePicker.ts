// promotePicker.ts — "Promote to {env}" entry point.
// Shows every story sitting on the previous stage's branch that hasn't been promoted to
// the target stage yet, and lets the user pick one — works regardless of which branch is
// currently checked out, unlike the old flow which silently acted on whatever feature
// branch happened to be current.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper, warnUncommittedChanges } from "../GitHelper";
import { StoryWebviewProvider } from "../providers/StoryWebviewProvider";
import { runPromotion } from "./promoteStory";
import { distinctStoryIdsFromCommits, CommitInfo } from "../DeploymentPlanner";
import { findEnvironment, getPromotableEnvironments, getPublishEnvironment, getTicketKeyPattern } from "../config";

interface PromoteCandidate {
    storyId:     string;
    commitCount: number;
    lastDate:    string;
    lastMessage: string;
}

async function findPromotionCandidates(
    gitHelper:    GitHelper,
    prevBranch:   string,
    targetBranch: string
): Promise<PromoteCandidate[]> {
    let commits: CommitInfo[];
    try {
        commits = await gitHelper.commitLogBetween(targetBranch, prevBranch);
    } catch {
        throw new Error(`Could not compare ${prevBranch} against ${targetBranch} — check both branches exist on origin.`);
    }

    const byStory = distinctStoryIdsFromCommits(commits, getTicketKeyPattern());

    const out: PromoteCandidate[] = [];
    for (const [storyId, storyCommits] of byStory) {
        // Greps the whole target-branch history for the story id — survives squash-merges
        // (which replace the commit message with the PR title, not the raw squash commit).
        const alreadyOnTarget = await gitHelper.storyCommitShaOnBranch(targetBranch, storyId);
        if (alreadyOnTarget) { continue; }
        const latest = storyCommits[0]; // git log is newest-first
        out.push({ storyId, commitCount: storyCommits.length, lastDate: latest.date, lastMessage: latest.message });
    }
    return out.sort((a, b) => a.storyId.localeCompare(b.storyId));
}

export async function promoteViaPicker(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    targetEnv:     string,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const envCfg = findEnvironment(targetEnv);
    if (!envCfg) {
        vscode.window.showErrorMessage(`Unknown environment "${targetEnv}" — check sfDevops.environments.`);
        return;
    }

    await gitHelper.fetchRemote();

    const promotable = getPromotableEnvironments();
    const idx     = promotable.findIndex(e => e.name === targetEnv);
    const prevEnv = idx > 0 ? promotable[idx - 1] : getPublishEnvironment();

    // Same hard gate as Deploy/Validate and the direct promote command — enforced again
    // here so the picker can never be used to bypass it, even though runPromotion (called
    // below once a story is picked) also enforces it independently.
    if (idx > 0) {
        const gap = await gitHelper.checkPrevEnvDeployed(prevEnv, envCfg.label);
        if (gap.blocked) {
            vscode.window.showWarningMessage(gap.reason!);
            return;
        }
    }

    let candidates: PromoteCandidate[];
    try {
        candidates = await findPromotionCandidates(gitHelper, prevEnv.branch, envCfg.branch);
    } catch (err) {
        vscode.window.showErrorMessage(String(err));
        return;
    }

    if (candidates.length === 0) {
        vscode.window.showInformationMessage(
            `Nothing to promote to ${envCfg.label} — every story on ${prevEnv.label} has already been promoted here.`
        );
        return;
    }

    const items = candidates.map(c => ({
        label:       c.storyId,
        description: `${c.commitCount} commit(s)`,
        detail:      `${c.lastDate.slice(0, 10)} — ${c.lastMessage}`,
        storyId:     c.storyId,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        title:       `Promote to ${envCfg.label}`,
        placeHolder: `Select a story currently on ${prevEnv.label} to promote to ${envCfg.label}`,
    });
    if (!picked) { return; }

    await promoteSelectedStory(bbClient, gitHelper, picked.storyId, targetEnv, storyProvider);
}

/**
 * Runs the existing promotion flow for an explicitly chosen story, from whatever branch
 * happens to be checked out — beginPromotion/finalizeAndFinish always end by checking out
 * the PROMOTED story's feature branch (never the one you started on), so this restores
 * the original branch afterward, mirroring the same originalBranch/checkoutBranch pattern
 * DeploymentDashboardPanel._runAction already uses for its own temporary branch switches.
 */
async function promoteSelectedStory(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyId:       string,
    targetEnv:     string,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    if (await gitHelper.hasUncommittedChanges()) {
        await warnUncommittedChanges(
            gitHelper,
            `Commit or stash your local changes before promoting ${storyId} — this checks out other branches temporarily.`
        );
        return;
    }

    const originalBranch = await gitHelper.currentBranch();
    try {
        await runPromotion(bbClient, gitHelper, storyId, targetEnv, "promote", storyProvider);
    } finally {
        if (originalBranch) { await gitHelper.checkoutBranch(originalBranch).catch(() => {}); }
        storyProvider.refresh();
    }
}
