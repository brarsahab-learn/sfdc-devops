// submitForReview.ts — "Commit & Publish Feature Branch" command
// Commits the STAGED metadata, pushes the feature branch, then cherry-picks the story
// straight onto the dev branch (no PR, no Dev org deploy). Conflicts on the dev
// cherry-pick use the same resolve-and-resume flow.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper, warnUncommittedChanges } from "../GitHelper";
import { StoryWebviewProvider} from "../providers/StoryWebviewProvider";
import { reportOperationConflict } from "./promoteStory";
import { isFeatureBranch, extractStoryId, getFeatureBranchPrefix } from "../config";
import { buildPackageXml } from "../AuditLog";
import { log } from "../Log";

export async function commitAndPush(
    _bbClient:     IGitProviderClient,
    gitHelper:     GitHelper,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const branch = await gitHelper.currentBranch();

    if (!isFeatureBranch(branch)) {
        vscode.window.showWarningMessage("You must be on a feature branch to commit and publish.");
        return;
    }

    // Fall back to the branch name (minus the feature-branch prefix) when no ticket-shaped
    // key can be extracted — e.g. a free-text branch like "feature/unmanaged-package-changes".
    // Without this, storyId ends up "" and featureBranchName("") builds a bogus/empty ref
    // for the merge-base lookup instead of the branch that's actually checked out.
    const storyId = extractStoryId(branch) || branch!.replace(getFeatureBranchPrefix(), "");
    if (!storyId) {
        vscode.window.showWarningMessage("Could not determine a story ID from the current branch name.");
        return;
    }

    const staged   = await gitHelper.stagedFiles();
    const unpushed = await gitHelper.unpushedCommitCount();

    // Nothing staged and nothing to push → guide the user.
    if (staged.length === 0 && unpushed === 0) {
        if (await gitHelper.hasUncommittedChanges()) {
            await warnUncommittedChanges(gitHelper, "Stage your metadata files first, then click Commit & Publish.");
        } else {
            vscode.window.showWarningMessage("No staged changes to publish.");
        }
        return;
    }

    // Commit message only needed when there are staged changes to commit.
    let commitMsg = "";
    if (staged.length > 0) {
        const defaultMsg = storyId ? `feat(${storyId}): ` : "feat: ";
        const input = await vscode.window.showInputBox({
            prompt:        "Commit message",
            value:         defaultMsg,
            validateInput: (v) => (v.trim().length > 5 ? undefined : "Please enter a meaningful message"),
        });
        if (!input) { return; }
        commitMsg = input.trim();

        // Multi-area mixing warning.
        const { areas, hasMultiple } = await gitHelper.detectMultipleAreas();
        if (hasMultiple) {
            const areaList = areas.slice(0, 6).join(", ") + (areas.length > 6 ? "..." : "");
            const choice   = await vscode.window.showWarningMessage(
                `Changes span ${areas.length} areas: ${areaList}\n\nAre ALL of these for ${storyId || "this story"}?`,
                { modal: true },
                "Yes, commit all",
                "Let me review first"
            );
            if (choice !== "Yes, commit all") { return; }
        }
    }

    await vscode.window.withProgress(
        {
            location:    vscode.ProgressLocation.Notification,
            title:       "Publishing feature branch and updating dev...",
            cancellable: false,
        },
        async (progress) => {
            const changedFiles = staged.map(path => ({ path, change: "modified" as const }));
            const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);
            const stashLabel = `sf-devops-autostash-${storyId}-${Date.now()}`;
            let stashed = false;

            try {
                progress.report({ message: "Committing & pushing feature branch..." });
                await gitHelper.commitStagedAndPushFeature(commitMsg || `feat(${storyId}): update`);

                // Anything still uncommitted at this point is separate, in-progress work that
                // wasn't staged for this publish — set it aside so the dev-branch checkout
                // below can't be blocked (or fail outright) by it, then restore it afterward.
                progress.report({ message: "Setting aside other in-progress edits..." });
                stashed = await gitHelper.stashUnstagedChanges(stashLabel);
                if (stashed) { log(`Stashed other in-progress edits on ${branch} — will restore them once dev is updated.`); }

                progress.report({ message: "Adding changes to dev branch..." });
                const outcome = await gitHelper.publishToDevBranch(storyId);

                if (outcome.status === "conflict") {
                    await gitHelper.appendAudit({
                        operation: "commitAndPublish",
                        storyId, branch: branch ?? undefined, outcome: "conflict",
                        summary: `Conflict adding ${storyId} to the dev branch`,
                        details: { commitMessage: commitMsg, changedFiles, packageXml, unmappedFiles, conflicts: outcome.conflicts },
                    });
                    await reportOperationConflict(gitHelper, outcome.conflicts, "dev branch");
                    return;
                }

                await gitHelper.appendAudit({
                    operation: "commitAndPublish",
                    storyId, branch: branch ?? undefined, outcome: "success",
                    summary: `Published — feature branch pushed, changes added to dev`,
                    details: { commitMessage: commitMsg, changedFiles, packageXml, unmappedFiles },
                });

                vscode.window.showInformationMessage(
                    `✅ ${storyId} published — feature branch pushed and changes added to the dev branch. ` +
                    `Use "Promote" or "Validate Only" for the next environment.`
                );
            } catch (err) {
                await gitHelper.appendAudit({
                    operation: "commitAndPublish",
                    storyId, branch: branch ?? undefined, outcome: "failure",
                    summary: "Commit & Publish failed",
                    details: { commitMessage: commitMsg, changedFiles, packageXml, unmappedFiles, error: String(err) },
                });
                vscode.window.showErrorMessage(`Commit & Publish failed: ${err}`);
            } finally {
                if (stashed) {
                    const restore = await gitHelper.restoreStash(stashLabel);
                    if (restore.status === "restored") {
                        log("Restored your other in-progress edits.");
                    } else if (restore.status === "conflict") {
                        vscode.window.showWarningMessage(
                            `Your in-progress edits are safe but conflicted while restoring — resolve the conflict markers now showing in your files (Source Control view), then run "git stash drop" to finish (stash: ${restore.ref}).`
                        );
                    }
                }
                storyProvider.refresh();
            }
        }
    );
}

