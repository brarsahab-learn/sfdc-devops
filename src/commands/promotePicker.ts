// promotePicker.ts — "Promote to {env}" entry point.
// Shows every story sitting on the previous stage's branch that hasn't been promoted to
// the target stage yet.  Supports multi-select so several stories can be queued in one
// session.  After selection a change-preview step lists every file touched per story so
// the developer knows exactly what is about to be validated/deployed before anything runs.

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
        const alreadyOnTarget = await gitHelper.storyCommitShaOnBranch(targetBranch, storyId);
        if (alreadyOnTarget) { continue; }
        const latest = storyCommits[0]; // git log is newest-first
        out.push({ storyId, commitCount: storyCommits.length, lastDate: latest.date, lastMessage: latest.message });
    }
    return out.sort((a, b) => a.storyId.localeCompare(b.storyId));
}

/**
 * Builds a QuickPick-compatible file preview for a batch of stories.
 * Shows a "Promote N stories" action item at the top so the user can confirm from inside
 * the same list they just reviewed — no separate modal needed.
 * Returns true when the user clicked the Promote action; false / undefined if they escaped.
 */
async function showChangePreview(
    gitHelper:   GitHelper,
    storyIds:    string[],
    envLabel:    string,
): Promise<boolean> {
    const actionLabel = storyIds.length === 1
        ? `$(rocket)  Promote ${storyIds[0]} to ${envLabel}`
        : `$(rocket)  Promote all ${storyIds.length} stories to ${envLabel}`;

    const items: vscode.QuickPickItem[] = [
        {
            label:       actionLabel,
            description: "Select this to start — validations run one story at a time",
            alwaysShow:  true,
        },
        { kind: vscode.QuickPickItemKind.Separator, label: "Changes included" },
    ];

    for (const storyId of storyIds) {
        items.push({ kind: vscode.QuickPickItemKind.Separator, label: storyId });
        try {
            const files = await gitHelper.previewStoryFiles(storyId);
            if (files.length === 0) {
                items.push({ label: "  (no metadata changes)", description: storyId });
            } else {
                const shown = files.slice(0, 25);
                for (const f of shown) {
                    const icon = f.change === "added" ? "$(add)" : f.change === "deleted" ? "$(trash)" : "$(edit)";
                    items.push({ label: `  ${icon}  ${f.path}`, description: f.change });
                }
                if (files.length > 25) {
                    items.push({ label: `  … and ${files.length - 25} more`, description: "" });
                }
            }
        } catch {
            items.push({ label: "  (could not load file list — branch may not be pushed yet)", description: storyId });
        }
    }

    const picked = await vscode.window.showQuickPick(items, {
        title:           `Change Preview — Promoting to ${envLabel}`,
        placeHolder:     "Review changes, then select 'Promote' at the top to begin",
        canPickMany:     false,
        ignoreFocusOut:  true,
    });

    return Boolean(picked && picked.label === actionLabel);
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
        picked:      false,
    }));

    // ── Step 1: select stories (multi-select) ─────────────────────────────────
    const selected = await vscode.window.showQuickPick(items, {
        title:       `Promote to ${envCfg.label}`,
        placeHolder: `Select stories to promote (Space to toggle, Enter to confirm)`,
        canPickMany: true,
    });
    if (!selected || selected.length === 0) { return; }

    // ── Step 2: change preview before anything runs ───────────────────────────
    const confirmed = await showChangePreview(
        gitHelper,
        selected.map(s => s.storyId),
        envCfg.label,
    );
    if (!confirmed) { return; }

    // ── Step 3: run promotions sequentially ───────────────────────────────────
    for (const pick of selected) {
        await promoteSelectedStory(bbClient, gitHelper, pick.storyId, targetEnv, storyProvider);
    }
}

/**
 * Runs the existing promotion flow for an explicitly chosen story, from whatever branch
 * happens to be checked out.  Restores the original branch after the promotion finishes
 * (beginPromotion / finalizeAndFinish end on the promoted story's feature branch, not the
 * one the user started on).
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
