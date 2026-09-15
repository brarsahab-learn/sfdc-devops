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
        vscode.window.showWarningMessage("Sync is only available on feature branches.");
        return;
    }

    if (await gitHelper.hasUncommittedChanges()) {
        await warnUncommittedChanges(gitHelper, "Commit or stash your changes before syncing.");
        return;
    }

    const base = getBaseBranch();

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title:    `Syncing ${branch}…`,
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
                    `✅ ${branch} is up to date with origin and ${base}`
                );
                storyProvider.refresh();
            } catch (err) {
                await gitHelper.appendAudit({
                    operation: "syncBranch", branch: branch ?? undefined, outcome: "failure",
                    summary: `Sync failed for ${branch}`,
                    details: { error: String(err) },
                });
                vscode.window.showErrorMessage(
                    `Sync failed: ${err}\n\nResolve conflicts manually then run: git rebase --continue`
                );
            }
        }
    );
}
