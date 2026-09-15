// syncBranch.ts — "Sync Branch with Dev" command

import * as vscode from "vscode";
import { GitHelper, warnUncommittedChanges } from "../GitHelper";
import { StoryWebviewProvider}from "../providers/StoryWebviewProvider";
import { isFeatureBranch, getBaseBranch } from "../config";

export async function syncBranch(
    gitHelper:     GitHelper,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const branch = await gitHelper.currentBranch();

    if (!isFeatureBranch(branch)) {
        vscode.window.showWarningMessage("This is only available on story branches.");
        return;
    }

    if (await gitHelper.hasUncommittedChanges()) {
        await warnUncommittedChanges(gitHelper, "Save or discard your unsaved changes before getting the latest.");
        return;
    }

    const base = getBaseBranch();

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title:    `Getting latest changes for ${branch}…`,
            cancellable: false,
        },
        async () => {
            try {
                await gitHelper.syncWithDev();
                await gitHelper.appendAudit({
                    operation: "syncBranch", branch: branch ?? undefined, outcome: "success",
                    summary: `Synced ${branch} with origin and ${base}`,
                });
                vscode.window.showInformationMessage(
                    `✅ Your branch is up to date — all latest changes are included.`
                );
                storyProvider.refresh();
            } catch (err) {
                await gitHelper.appendAudit({
                    operation: "syncBranch", branch: branch ?? undefined, outcome: "failure",
                    summary: `Sync failed for ${branch}`,
                    details: { error: String(err) },
                });
                vscode.window.showErrorMessage(
                    `Could not get the latest changes: ${err}\n\nThere may be a conflict with changes from a teammate. Resolve the conflict in each affected file, then try again.`
                );
            }
        }
    );
}
