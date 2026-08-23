// syncBranch.ts — "Sync Branch with Dev" command

import * as vscode from "vscode";
import { GitHelper }          from "../GitHelper";
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
        vscode.window.showWarningMessage(
            "Commit or stash your changes before syncing."
        );
        return;
    }

    const base = getBaseBranch();

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title:    `Syncing ${branch} with ${base}...`,
            cancellable: false,
        },
        async () => {
            try {
                await gitHelper.syncWithDev();
                vscode.window.showInformationMessage(
                    `✅ ${branch} synced with ${base}`
                );
                storyProvider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Sync failed: ${err}\n\nResolve conflicts manually then run: git rebase --continue`
                );
            }
        }
    );
}
