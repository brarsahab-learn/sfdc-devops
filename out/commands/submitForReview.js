"use strict";
// submitForReview.ts — "Commit & Publish Feature Branch" command
// Commits the STAGED metadata, pushes the feature branch, then cherry-picks the story
// straight onto the dev branch (no PR, no Dev org deploy). Conflicts on the dev
// cherry-pick use the same resolve-and-resume flow.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.commitAndPush = commitAndPush;
const vscode = __importStar(require("vscode"));
const GitHelper_1 = require("../GitHelper");
const promoteStory_1 = require("./promoteStory");
const config_1 = require("../config");
const AuditLog_1 = require("../AuditLog");
const Log_1 = require("../Log");
async function commitAndPush(_bbClient, gitHelper, storyProvider) {
    const branch = await gitHelper.currentBranch();
    if (!(0, config_1.isFeatureBranch)(branch)) {
        // A dead-end "you must be on a feature branch" message is unhelpful when there's
        // real staged/uncommitted work sitting right here (e.g. the Deployment Dashboard
        // correctly returned you to wherever you started, which happened to not be a
        // feature branch) — say what's actually here and offer a way to get to a feature
        // branch instead of just stopping.
        const staged = await gitHelper.stagedFiles();
        const other = await gitHelper.workingTreeFiles();
        if (staged.length > 0 || other.length > 0) {
            const otherCount = other.length - staged.length;
            const parts = [];
            if (staged.length > 0) {
                parts.push(`${staged.length} staged`);
            }
            if (otherCount > 0) {
                parts.push(`${otherCount} other uncommitted`);
            }
            const choice = await vscode.window.showWarningMessage(`You're on "${branch}", not a feature branch — Commit & Publish only works from one. ` +
                `You have ${parts.join(" and ")} file(s) here that won't be touched.`, "Review Changes", "Start New Story", "Continue with Existing Story");
            if (choice === "Review Changes") {
                await vscode.commands.executeCommand("workbench.view.scm");
            }
            else if (choice === "Start New Story") {
                await vscode.commands.executeCommand("sfDevops.startStory");
            }
            else if (choice === "Continue with Existing Story") {
                await vscode.commands.executeCommand("sfDevops.resumeStory");
            }
        }
        else {
            vscode.window.showWarningMessage("You must be on a feature branch to commit and publish.");
        }
        return;
    }
    // Fall back to the branch name (minus the feature-branch prefix) when no ticket-shaped
    // key can be extracted — e.g. a free-text branch like "feature/unmanaged-package-changes".
    // Without this, storyId ends up "" and featureBranchName("") builds a bogus/empty ref
    // for the merge-base lookup instead of the branch that's actually checked out.
    const storyId = (0, config_1.extractStoryId)(branch) || branch.replace((0, config_1.getFeatureBranchPrefix)(), "");
    if (!storyId) {
        vscode.window.showWarningMessage("Could not determine a story ID from the current branch name.");
        return;
    }
    const staged = await gitHelper.stagedFiles();
    const unpushed = await gitHelper.unpushedCommitCount();
    // Nothing staged and nothing to push → guide the user.
    if (staged.length === 0 && unpushed === 0) {
        if (await gitHelper.hasUncommittedChanges()) {
            await (0, GitHelper_1.warnUncommittedChanges)(gitHelper, "Stage your metadata files first, then click Commit & Publish.");
        }
        else {
            vscode.window.showWarningMessage("No staged changes to publish.");
        }
        return;
    }
    // Commit message only needed when there are staged changes to commit.
    let commitMsg = "";
    if (staged.length > 0) {
        const defaultMsg = storyId ? `feat(${storyId}): ` : "feat: ";
        const input = await vscode.window.showInputBox({
            prompt: "Commit message",
            value: defaultMsg,
            validateInput: (v) => (v.trim().length > 5 ? undefined : "Please enter a meaningful message"),
        });
        if (!input) {
            return;
        }
        commitMsg = input.trim();
        // Multi-area mixing warning.
        const { areas, hasMultiple } = await gitHelper.detectMultipleAreas();
        if (hasMultiple) {
            const areaList = areas.slice(0, 6).join(", ") + (areas.length > 6 ? "..." : "");
            const choice = await vscode.window.showWarningMessage(`Changes span ${areas.length} areas: ${areaList}\n\nAre ALL of these for ${storyId || "this story"}?`, { modal: true }, "Yes, commit all", "Let me review first");
            if (choice !== "Yes, commit all") {
                return;
            }
        }
    }
    // Another story (or a promotion) can be sitting mid-conflict right now — publishToDevBranch
    // would otherwise silently `cherry-pick --abort` it with no warning, orphaning its "Resume"
    // state. Surface it and let the user choose instead.
    let discardConflicting = false;
    const conflicting = await gitHelper.conflictingPendingOperation(storyId);
    if (conflicting) {
        const label = `${conflicting.storyId}${conflicting.targetEnv ? ` → ${conflicting.targetEnv}` : " (dev publish)"}`;
        const choice = await vscode.window.showWarningMessage(`${label} has an unresolved conflict from an earlier operation.\n\n` +
            `Starting this now will discard that conflict and its "Resume" state — the other operation cannot be recovered afterward.`, { modal: true }, "Discard it and continue");
        if (!choice) {
            return;
        }
        discardConflicting = true;
    }
    // A real publish can take well past a few seconds (a push, then the dev-branch cherry-
    // pick and its own push) — refuse a second click on this exact story that lands while
    // one's already running instead of racing two git operations against the same tree.
    const lockKey = `publish:${storyId}`;
    if (!gitHelper.tryBeginOperation(lockKey)) {
        vscode.window.showWarningMessage(`Already publishing ${storyId} — give it a moment to finish before clicking again.`);
        return;
    }
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Publishing feature branch and updating dev...",
            cancellable: false,
        }, async (progress) => {
            const changedFiles = staged.map(path => ({ path, change: "modified" }));
            const { xml: packageXml, unmapped: unmappedFiles } = (0, AuditLog_1.buildPackageXml)(changedFiles);
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
                if (stashed) {
                    (0, Log_1.log)(`Stashed other in-progress edits on ${branch} — will restore them once dev is updated.`);
                }
                progress.report({ message: "Adding changes to dev branch..." });
                const outcome = await gitHelper.publishToDevBranch(storyId, discardConflicting);
                if (outcome.status === "conflict") {
                    await gitHelper.appendAudit({
                        operation: "commitAndPublish",
                        storyId, branch: branch ?? undefined, outcome: "conflict",
                        summary: `Conflict adding ${storyId} to the dev branch`,
                        details: { commitMessage: commitMsg, changedFiles, packageXml, unmappedFiles, conflicts: outcome.conflicts },
                    });
                    await (0, promoteStory_1.reportOperationConflict)(gitHelper, outcome.conflicts, "dev branch");
                    return;
                }
                await gitHelper.appendAudit({
                    operation: "commitAndPublish",
                    storyId, branch: branch ?? undefined, outcome: "success",
                    summary: `Published — feature branch pushed, changes added to dev`,
                    details: { commitMessage: commitMsg, changedFiles, packageXml, unmappedFiles },
                });
                vscode.window.showInformationMessage(`✅ ${storyId} published — feature branch pushed and changes added to the dev branch. ` +
                    `Use "Promote" or "Validate Only" for the next environment.`);
            }
            catch (err) {
                await gitHelper.appendAudit({
                    operation: "commitAndPublish",
                    storyId, branch: branch ?? undefined, outcome: "failure",
                    summary: "Commit & Publish failed",
                    details: { commitMessage: commitMsg, changedFiles, packageXml, unmappedFiles, error: String(err) },
                });
                vscode.window.showErrorMessage(`Commit & Publish failed: ${err}`);
            }
            finally {
                if (stashed) {
                    const restore = await gitHelper.restoreStash(stashLabel);
                    if (restore.status === "restored") {
                        (0, Log_1.log)("Restored your other in-progress edits.");
                    }
                    else if (restore.status === "conflict") {
                        vscode.window.showWarningMessage(`Your in-progress edits are safe but conflicted while restoring — resolve the conflict markers now showing in your files (Source Control view), then run "git stash drop" to finish (stash: ${restore.ref}).`);
                    }
                }
                storyProvider.refresh();
            }
        });
    }
    finally {
        gitHelper.endOperation(lockKey);
    }
}
//# sourceMappingURL=submitForReview.js.map