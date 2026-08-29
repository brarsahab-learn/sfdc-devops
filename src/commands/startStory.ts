// startStory.ts — "Start New Story" command
// Creates a correctly-named feature branch from dev with one prompt

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper, warnUncommittedChanges } from "../GitHelper";
import { StoryWebviewProvider}from "../providers/StoryWebviewProvider";
import { getTicketSystem, sanitizeStoryId, isFeatureBranch, extractStoryId, getEnvironments } from "../config";
import { getStoryProgress } from "../StoryProgress";

export async function startStory(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    // Check for uncommitted changes first
    if (await gitHelper.hasUncommittedChanges()) {
        await warnUncommittedChanges(gitHelper, "You have uncommitted changes. Please commit or stash them before starting a new story.");
        return;
    }

    // Doesn't block — just catches the "forgot I had something in flight" case. A team
    // legitimately running multiple stories in parallel can just continue past it.
    const currentBranch = await gitHelper.currentBranch();
    if (isFeatureBranch(currentBranch)) {
        const currentStoryId = extractStoryId(currentBranch);
        if (currentStoryId) {
            const progress = await getStoryProgress(gitHelper, bbClient, currentStoryId);
            const pending = getEnvironments().filter(e => progress[e.name] === "open" || progress[e.name] === "merged");
            if (pending.length > 0) {
                const summary = pending
                    .map(e => `${e.label} (${progress[e.name] === "merged" ? "merged, not deployed" : "open PR"})`)
                    .join(", ");
                const choice = await vscode.window.showWarningMessage(
                    `${currentStoryId} still has unfinished pipeline work: ${summary}. Starting a new story won't stop it — it'll keep waiting for you (or someone else) to finish.`,
                    { modal: true },
                    "Continue Anyway"
                );
                if (!choice) { return; }
            }
        }
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
            sanitizeStoryId(v).length > 0 ? undefined : "Enter a story ID or short description with at least one letter/number",
    });
    if (!storyId) { return; }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title:    `Creating branch for ${storyId}...`,
            cancellable: false,
        },
        async () => {
            const cleanStoryId = sanitizeStoryId(storyId).toUpperCase();
            try {
                const branchName = await gitHelper.createFeatureBranch(cleanStoryId);

                await gitHelper.appendAudit({
                    operation: "startStory",
                    storyId:   cleanStoryId,
                    branch:    branchName,
                    outcome:   "success",
                    summary:   `Created and pushed ${branchName}`,
                });

                const repoOverride = await gitHelper.resolveRepoIdentity(bbClient);
                const branchUrl    = bbClient.buildBranchUrl(branchName, repoOverride);

                vscode.window.showInformationMessage(
                    `✅ Branch created: ${branchName}`,
                    ...(branchUrl ? ["View Branch in Browser"] : []),
                    "Open Terminal"
                ).then((choice: string | undefined) => {
                    if (choice === "Open Terminal") {
                        vscode.commands.executeCommand("workbench.action.terminal.new");
                    } else if (choice === "View Branch in Browser" && branchUrl) {
                        vscode.env.openExternal(vscode.Uri.parse(branchUrl));
                    }
                });

                storyProvider.refresh();
            } catch (err) {
                await gitHelper.appendAudit({
                    operation: "startStory",
                    storyId:   cleanStoryId,
                    outcome:   "failure",
                    summary:   "Failed to create branch",
                    details:   { error: String(err) },
                });
                vscode.window.showErrorMessage(`Failed to create branch: ${err}`);
            }
        }
    );
}
