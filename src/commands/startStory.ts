// startStory.ts — "Start New Story" command
// Creates a correctly-named feature branch from dev with one prompt

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper }          from "../GitHelper";
import { StoryWebviewProvider}from "../providers/StoryWebviewProvider";
import { getTicketSystem } from "../config";

export async function startStory(
    _bbClient:     IGitProviderClient,
    gitHelper:     GitHelper,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    // Check for uncommitted changes first
    if (await gitHelper.hasUncommittedChanges()) {
        vscode.window.showWarningMessage(
            "You have uncommitted changes. Please commit or stash them before starting a new story."
        );
        return;
    }

    // Get the story/ticket ID from whichever ticketing system is configured
    // (sfDevops.ticketSystem). Any format is accepted here, including free text
    // (e.g. "IB-123" or an arbitrary description) — sfDevops.ticketKeyPattern is
    // only used later to extract a key back out of a branch name.
    const ticketSystem = getTicketSystem();
    const label        = ticketSystem === "none" ? "Story ID" : `${ticketSystem[0].toUpperCase()}${ticketSystem.slice(1)} Story ID`;

    const storyId = await vscode.window.showInputBox({
        prompt:      `Enter ${label}`,
        placeHolder: ticketSystem === "none" ? "e.g. STORY-101" : "PROJ-123",
        validateInput: (v: string) =>
            v.trim().length > 0 ? undefined : "Story ID cannot be empty",
    });
    if (!storyId) { return; }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title:    `Creating branch for ${storyId}...`,
            cancellable: false,
        },
        async () => {
            try {
                const branchName = await gitHelper.createFeatureBranch(
                    storyId.trim().toUpperCase()
                );

                vscode.window.showInformationMessage(
                    `✅ Branch created: ${branchName}`,
                    "Open Terminal"
                ).then((choice: string | undefined) => {
                    if (choice === "Open Terminal") {
                        vscode.commands.executeCommand("workbench.action.terminal.new");
                    }
                });

                storyProvider.refresh();
            } catch (err) {
                vscode.window.showErrorMessage(`Failed to create branch: ${err}`);
            }
        }
    );
}
