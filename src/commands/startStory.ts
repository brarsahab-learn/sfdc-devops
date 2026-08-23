// startStory.ts — "Start New Story" command
// Creates a correctly-named feature branch from dev with one prompt

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper }          from "../GitHelper";
import { StoryWebviewProvider}from "../providers/StoryWebviewProvider";
import { getTicketKeyPattern, getTicketSystem } from "../config";

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
    // (sfDevops.ticketSystem / sfDevops.ticketKeyPattern). Any format works, including
    // free text, when ticketSystem is "none".
    const ticketSystem = getTicketSystem();
    const pattern      = getTicketKeyPattern();
    const anchored     = new RegExp(`^(?:${pattern.source})$`, pattern.flags);
    const label        = ticketSystem === "none" ? "Story ID" : `${ticketSystem[0].toUpperCase()}${ticketSystem.slice(1)} Story ID`;

    const storyId = await vscode.window.showInputBox({
        prompt:      `Enter ${label}`,
        placeHolder: ticketSystem === "none" ? "e.g. STORY-101" : "PROJ-123",
        validateInput: (v: string) =>
            ticketSystem === "none" || anchored.test(v.trim()) ? undefined : "Doesn't match sfDevops.ticketKeyPattern",
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
