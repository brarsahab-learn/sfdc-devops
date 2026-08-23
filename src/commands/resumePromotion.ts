// resumePromotion.ts — "Resume" / "Cancel" for a paused cherry-pick.
// Continues an in-progress operation (dev-publish OR promotion) after conflicts are
// resolved. If more commits still conflict, it stops again for further resolution.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper }            from "../GitHelper";
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

    const label = op.kind === "dev-publish" ? "dev branch" : (op.targetEnv ?? "").toUpperCase();

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
                    await reportOperationConflict(outcome.conflicts, label);
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

                // promotion
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

