// promoteStory.ts — "Promote & Deploy" and "Validate Only" commands (QA/UAT).
// Copado model: a promotion branch is cut from the target env branch and the story is
// cherry-picked onto it.
//   • Validate Only  → push the promotion branch → check-only validation runs.
//   • Promote & Deploy → push the promotion branch + open a prefilled PR (promotion → env).
//     The target org deploy runs when that PR is approved & merged.
// Promote & Deploy REUSES an existing (validated) promotion branch. Cherry-pick conflicts
// are left in place for the resolve-and-resume flow.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper }        from "../GitHelper";
import { StoryWebviewProvider } from "../providers/StoryWebviewProvider";
import { coverageSettings } from "./coverageCheck";
import {
    isFeatureBranch, extractStoryId, getFeatureBranchPrefix,
    getCoverageGateEnvironment, promoBranchName, getBaseBranch, featureBranchName,
} from "../config";
import { buildPackageXml, AuditChangedFile } from "../AuditLog";

export type PromoteMode = "validate" | "promote";

/** Metadata changed on the story's feature branch vs base — used for the audit trail. */
async function storyChangedFiles(gitHelper: GitHelper, storyId: string): Promise<AuditChangedFile[]> {
    try {
        return await gitHelper.diffNameStatusBetween(getBaseBranch(), featureBranchName(storyId));
    } catch {
        return [];
    }
}

export async function promoteStory(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    targetEnv:     string,
    mode:          PromoteMode,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const branch = await gitHelper.currentBranch();

    if (!isFeatureBranch(branch)) {
        vscode.window.showWarningMessage("You must be on a feature branch to promote or validate.");
        return;
    }

    const storyId  = extractStoryId(branch) || branch!.replace(getFeatureBranchPrefix(), "");
    const envUpper = targetEnv.toUpperCase();

    // One-time coverage gate: block the first promotion into the configured gate
    // environment when the story has Apex classes and coverage hasn't reached the
    // threshold in the dev org yet. sfDevops.environments[].coverageGate decides which
    // environment (if any) this applies to.
    const gateEnv = getCoverageGateEnvironment();
    if (mode === "promote" && gateEnv && targetEnv === gateEnv.name) {
        const apex = await gitHelper.featureApexClasses(storyId);
        if (apex.length > 0 && !(await gitHelper.isCoveragePassed(storyId))) {
            const { threshold } = coverageSettings();
            const choice = await vscode.window.showWarningMessage(
                `${storyId} has Apex classes (${apex.slice(0, 4).join(", ")}${apex.length > 4 ? ", …" : ""}). ` +
                `Run the Code Coverage check (≥ ${threshold}%) in the Code Coverage panel before promoting to ${gateEnv.label}.`,
                "Open Coverage Panel"
            );
            if (choice === "Open Coverage Panel") {
                await vscode.commands.executeCommand("sfDevopsCoverageView.focus");
            }
            return;
        }
    }

    // Copado reuse: Promote & Deploy on an already-validated promotion branch just opens the PR.
    if (mode === "promote" && await gitHelper.promotionBranchExists(storyId, targetEnv)) {
        const confirm = await vscode.window.showWarningMessage(
            `Promote & Deploy ${storyId} to ${envUpper}?\n\nThe validated promotion branch already exists — this will open its PR (promotion → ${targetEnv}). ${envUpper} deploys once you approve & merge it.`,
            { modal: true },
            "Yes, open PR"
        );
        if (!confirm) { return; }
        await openPromotionPR(bbClient, gitHelper, storyId, targetEnv, storyProvider);
        return;
    }

    const promoBranch = promoBranchName(storyId, targetEnv, mode);
    const confirmMsg = mode === "validate"
        ? `Validate ${storyId} against ${envUpper}?\n\nThis will:\n• Create ${promoBranch} from ${targetEnv}\n• Add your story's changes\n• Run a check-only validation against ${envUpper} (no deploy)`
        : `Promote & Deploy ${storyId} to ${envUpper}?\n\nThis will:\n• Create ${promoBranch} from ${targetEnv}\n• Add your story's changes\n• Open a PR (promotion → ${targetEnv})\n• Deploy to ${envUpper} once you approve & merge the PR`;
    const confirmLabel = mode === "validate" ? `Yes, validate against ${envUpper}` : "Yes, Promote & Deploy";
    const confirm = await vscode.window.showWarningMessage(confirmMsg, { modal: true }, confirmLabel);
    if (!confirm) { return; }

    await vscode.window.withProgress(
        {
            location:    vscode.ProgressLocation.Notification,
            title:       `${mode === "validate" ? "Validating" : "Promoting"} ${storyId} → ${envUpper}...`,
            cancellable: false,
        },
        async (progress) => {
            try {
                progress.report({ message: "Creating promotion branch..." });
                const outcome = await gitHelper.beginPromotion(storyId, targetEnv, mode);

                if (outcome.status === "conflict") {
                    const changedFiles = await storyChangedFiles(gitHelper, storyId);
                    const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);
                    await gitHelper.appendAudit({
                        operation: mode, storyId, targetEnv, outcome: "conflict",
                        summary: `Conflict preparing promotion branch for ${envUpper}`,
                        details: { changedFiles, packageXml, unmappedFiles, conflicts: outcome.conflicts },
                    });
                    await reportOperationConflict(outcome.conflicts, envUpper);
                    storyProvider.refresh();
                    return;
                }

                await finalizeAndFinish(bbClient, gitHelper, storyId, targetEnv, mode, storyProvider, progress);
            } catch (err) {
                await gitHelper.appendAudit({
                    operation: mode, storyId, targetEnv, outcome: "failure",
                    summary: `${mode === "validate" ? "Validation" : "Promotion"} failed`,
                    details: { error: String(err) },
                });
                vscode.window.showErrorMessage(`${mode === "validate" ? "Validation" : "Promotion"} failed: ${err}`);
            }
        }
    );
}

/**
 * Pushes the completed promotion branch (triggers validation), then either notifies
 * (validate) or opens the prefilled PR page (promote). Returns to the feature branch.
 */
export async function finalizeAndFinish(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyId:       string,
    targetEnv:     string,
    mode:          PromoteMode,
    storyProvider: StoryWebviewProvider,
    progress?:     vscode.Progress<{ message?: string }>
): Promise<void> {
    progress?.report({ message: mode === "validate" ? "Pushing validation branch..." : "Pushing promotion branch..." });
    await gitHelper.finalizePromotion(storyId, targetEnv, mode);

    if (mode === "validate") {
        const changedFiles = await storyChangedFiles(gitHelper, storyId);
        const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);
        await gitHelper.appendAudit({
            operation: "validate", storyId, targetEnv, outcome: "success",
            summary: `Validation branch pushed against ${targetEnv.toUpperCase()}`,
            details: { changedFiles, packageXml, unmappedFiles },
        });

        await gitHelper.checkoutFeature(storyId);
        vscode.window.showInformationMessage(
            `✅ Validation started for ${storyId} against ${targetEnv.toUpperCase()} (check-only — nothing is deployed). ` +
            `Once it passes, click "Promote & Deploy" to deploy the same branch.`
        );
        storyProvider.refresh();
        return;
    }

    await openPromotionPR(bbClient, gitHelper, storyId, targetEnv, storyProvider, progress);
}

/** Opens the prefilled "Create pull/merge request" page (promotion → target env) in the browser. */
export async function openPromotionPR(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyId:       string,
    targetEnv:     string,
    storyProvider: StoryWebviewProvider,
    progress?:     vscode.Progress<{ message?: string }>
): Promise<void> {
    const promotionBranch = promoBranchName(storyId, targetEnv, "promote");
    progress?.report({ message: "Opening pull request page..." });

    await gitHelper.checkoutFeature(storyId);

    const changedFiles = await storyChangedFiles(gitHelper, storyId);
    const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);

    let prUrl = bbClient.buildPrUrl(promotionBranch, targetEnv);
    if (!prUrl) {
        // Settings don't have the repo identity — try deriving it from the origin remote.
        const remoteUrl = await gitHelper.getRemoteUrl();
        const derived    = remoteUrl ? bbClient.parseRemoteUrl(remoteUrl) : null;
        if (derived) { prUrl = bbClient.buildPrUrl(promotionBranch, targetEnv, derived); }
    }
    if (!prUrl) {
        await gitHelper.appendAudit({
            operation: "promote", storyId, targetEnv, branch: promotionBranch, outcome: "success",
            summary: `${promotionBranch} pushed, but PR URL could not be determined`,
            details: { changedFiles, packageXml, unmappedFiles },
        });
        vscode.window.showWarningMessage(
            `${promotionBranch} was pushed, but the repo could not be determined. ` +
            `Set sfDevops.repoWorkspace and sfDevops.repoSlug to auto-open the PR page.`
        );
        storyProvider.refresh();
        return;
    }

    await gitHelper.appendAudit({
        operation: "promote", storyId, targetEnv, branch: promotionBranch, outcome: "success",
        summary: `${promotionBranch} pushed — PR opened against ${targetEnv.toUpperCase()}`,
        details: { changedFiles, packageXml, unmappedFiles, prUrl },
    });

    await vscode.env.openExternal(vscode.Uri.parse(prUrl));

    vscode.window.showInformationMessage(
        `✅ ${promotionBranch} pushed. Review & merge the PR (→ ${targetEnv}) in your browser — ` +
        `${targetEnv.toUpperCase()} deploys automatically once the PR is approved & merged.`
    );
    storyProvider.refresh();
}

/** Shows conflict guidance and offers to open the first conflicted file. */
export async function reportOperationConflict(
    conflicts: string[],
    label:     string
): Promise<void> {
    const list   = conflicts.slice(0, 8).join(", ") + (conflicts.length > 8 ? ", ..." : "");
    const choice = await vscode.window.showWarningMessage(
        `Conflicts while preparing ${label}:\n\n${list || "see Source Control"}\n\n` +
        `Resolve them in the editor (Source Control view), save, then run "Resume".`,
        "Open Conflicts",
        "Later"
    );

    if (choice === "Open Conflicts") {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri;
        if (root && conflicts[0]) {
            const fileUri = vscode.Uri.joinPath(root, conflicts[0]);
            await vscode.window.showTextDocument(fileUri).then(undefined, () => {});
        }
        await vscode.commands.executeCommand("workbench.view.scm");
    }
}


