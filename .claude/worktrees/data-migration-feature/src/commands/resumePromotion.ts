// resumePromotion.ts — "Resume" / "Cancel" for a paused cherry-pick.
// Continues an in-progress operation (dev-publish OR promotion) after conflicts are
// resolved. If more commits still conflict, it stops again for further resolution.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper, warnUncommittedChanges } from "../GitHelper";
import { StoryWebviewProvider } from "../providers/StoryWebviewProvider";
import { finalizeAndFinish, reportOperationConflict } from "./promoteStory";

export async function resumePromotion(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const op = await gitHelper.getPendingOperation();
    if (!op) {
        vscode.window.showInformationMessage("Nothing to resume.");
        storyProvider.refresh();
        return;
    }

    // A real resume can take well past a few seconds (git push, sometimes a real Salesforce
    // validate) — refuse a second click that lands while one's already running instead of
    // racing two git operations against the same working tree.
    const lockKey = `resume:${op.storyId}`;
    if (!gitHelper.tryBeginOperation(lockKey)) {
        vscode.window.showWarningMessage(`Already resuming ${op.storyId} — give it a moment to finish before clicking again.`);
        return;
    }

    const label = op.kind === "dev-publish" ? "dev branch" : (op.targetEnv ?? "").toUpperCase();
    const originalBranch = await gitHelper.currentBranch();
    let stashLabel: string | null = null;

    try {
        await vscode.window.withProgress(
            {
                location:    vscode.ProgressLocation.Notification,
                title:       `Resuming ${op.storyId} → ${label}...`,
                cancellable: false,
            },
            async (progress) => {
                try {
                    progress.report({ message: "Continuing after conflict resolution..." });
                    const outcome = await gitHelper.continuePendingOperation();

                    if (outcome.status === "conflict") {
                        await gitHelper.appendAudit({
                            operation: "resumePromotion", storyId: op.storyId, targetEnv: op.targetEnv,
                            outcome: "conflict",
                            summary: `Still conflicting while resuming → ${label}`,
                            details: { conflicts: outcome.conflicts },
                        });
                        await reportOperationConflict(gitHelper, outcome.conflicts, label);
                        storyProvider.refresh();
                        return;
                    }

                    await gitHelper.appendAudit({
                        operation: "resumePromotion", storyId: op.storyId, targetEnv: op.targetEnv,
                        outcome: "success",
                        summary: `Resumed cleanly → ${label}`,
                    });

                    if (op.kind === "dev-publish") {
                        progress.report({ message: "Pushing dev branch..." });
                        await gitHelper.completeDevPublish(op.storyId);
                        vscode.window.showInformationMessage(
                            `✅ ${op.storyId} added to the dev branch. Use "Promote & Deploy" or "Validate Only" for the next environment.`
                        );
                        storyProvider.refresh();
                        return;
                    }

                    // promotion — the just-resolved cherry-pick is local-only until pushed;
                    // finalizeAndFinish itself only validates+PRs whatever's already on origin.
                    // Same hard block runPromotion uses: finalizeAndFinish's validate step does
                    // its own checkout, which would collide with any OTHER uncommitted edits
                    // sitting around beyond what continuePendingOperation() just committed.
                    if (await gitHelper.hasUncommittedChanges()) {
                        stashLabel = await warnUncommittedChanges(
                            gitHelper,
                            "Commit or stash your local changes before resuming — the validate step that follows checks out a fresh copy from origin, which would collide with them.",
                            { offerStash: true }
                        );
                        if (!stashLabel) { return; }
                    }
                    progress.report({ message: "① Pushing promotion branch..." });
                    await gitHelper.finalizePromotion(op.storyId, op.targetEnv!, op.mode ?? "promote");
                    await finalizeAndFinish(
                        bbClient, gitHelper, op.storyId, op.targetEnv!, op.mode ?? "promote", storyProvider, progress
                    );
                } catch (err) {
                    await gitHelper.appendAudit({
                        operation: "resumePromotion", storyId: op.storyId, targetEnv: op.targetEnv,
                        outcome: "failure",
                        summary: "Resume failed",
                        details: { error: String(err) },
                    });
                    vscode.window.showErrorMessage(`Resume failed: ${err}`);
                }
            }
        );
    } finally {
        if (stashLabel) {
            if (originalBranch) { await gitHelper.checkoutBranch(originalBranch).catch(() => {}); }
            const restore = await gitHelper.restoreStash(stashLabel);
            if (restore.status === "conflict") {
                vscode.window.showWarningMessage(
                    `Your stashed changes are safe but conflicted while restoring — resolve the conflict markers now showing in your files (Source Control view), then run "git stash drop" to finish (stash: ${restore.ref}).`
                );
            }
        }
        gitHelper.endOperation(lockKey);
    }
}

/** "Cancel" — aborts the in-progress cherry-pick and returns to the story branch. */
export async function cancelPromotion(
    gitHelper:     GitHelper,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const op = await gitHelper.getPendingOperation();
    if (!op) {
        vscode.window.showInformationMessage("Nothing to cancel.");
        storyProvider.refresh();
        return;
    }

    const label = op.kind === "dev-publish" ? "dev publish" : `${(op.targetEnv ?? "").toUpperCase()} promotion`;
    const confirm = await vscode.window.showWarningMessage(
        `Cancel the ${label} for ${op.storyId}? Your resolved changes on this branch will be discarded.`,
        { modal: true },
        "Yes, cancel"
    );
    if (!confirm) { return; }

    await gitHelper.abortPendingOperation(op.storyId);
    await gitHelper.appendAudit({
        operation: "cancelPromotion", storyId: op.storyId, targetEnv: op.targetEnv,
        outcome: "success",
        summary: `Cancelled the ${label} for ${op.storyId}`,
    });
    vscode.window.showInformationMessage(`Cancelled — back on feature/${op.storyId}.`);
    storyProvider.refresh();
}

