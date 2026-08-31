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
    getCoverageGateEnvironment, promoBranchName, getBaseBranch, featureBranchName, getEnvironments,
    findEnvironment, getPromotableEnvironments,
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

/**
 * Branch-scoped wrapper: derives the story from whatever's currently checked out, then
 * runs the shared promotion flow. Used by "Validate Only," which stays tied to the
 * current branch. "Promote" itself goes through the multi-story picker (promotePicker.ts)
 * → runPromotion directly, since promoting shouldn't require checking out a branch first.
 */
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

    const storyId = extractStoryId(branch) || branch!.replace(getFeatureBranchPrefix(), "");
    await runPromotion(bbClient, gitHelper, storyId, targetEnv, mode, storyProvider);
}

export async function runPromotion(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyId:       string,
    targetEnv:     string,
    mode:          PromoteMode,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const envUpper = targetEnv.toUpperCase();
    // The real git branch this environment deploys — usually equal to its name, but can
    // differ (e.g. "prod" → branch "main"). Everything below that needs a real git ref
    // uses this; targetEnv itself stays the logical name for gating/audit/labels.
    const targetBranch = findEnvironment(targetEnv)?.branch ?? targetEnv;

    // Hard gate: the stage immediately before targetEnv must actually be deployed (not
    // just merged) — skipped for the first promotable env, whose "previous stage" is the
    // publish env (e.g. dev), which has no deploy step to check. Enforced here so it can't
    // be bypassed by any caller (Command Palette, the picker, a future entry point) —
    // never just a hidden/disabled button.
    const promotable = getPromotableEnvironments();
    const targetIdx = promotable.findIndex(e => e.name === targetEnv);
    if (targetIdx > 0) {
        const gap = await gitHelper.checkPrevEnvDeployed(promotable[targetIdx - 1], envUpper);
        if (gap.blocked) {
            vscode.window.showWarningMessage(gap.reason!);
            return;
        }
    }

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

    // Manual sign-off gate: the environment the story is CURRENTLY sitting in (the one
    // immediately before targetEnv) may require a recorded human sign-off before the
    // story can be promoted onward — e.g. QA sign-off before UAT, then UAT sign-off
    // before whatever's next. sfDevops.environments[].signoffGate decides which
    // environment(s) require this.
    if (mode === "promote") {
        const envs = getEnvironments();
        const targetIdx = envs.findIndex(e => e.name === targetEnv);
        const currentEnv = targetIdx > 0 ? envs[targetIdx - 1] : undefined;
        if (currentEnv?.signoffGate && !(await gitHelper.isSignoffPassed(storyId, currentEnv.name))) {
            vscode.window.showWarningMessage(
                `${currentEnv.label} sign-off hasn't been recorded for ${storyId} yet. Record it in the Current Story panel before promoting to ${envUpper}.`
            );
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

    // Promote (not Validate — lower-stakes, re-runnable, and this is the same asymmetry
    // Deploy's own confirm already has) gets an explicit "here's exactly what's about to go
    // out" file list before anything real happens — previously the only place this list
    // existed was the Output Channel log, written by beginPromotion AFTER the cherry-pick
    // had already started. A story with nothing new to promote (already fully promoted) is
    // caught here too, instead of running the branch-creation dance into a doomed no-op.
    let filesBlock = "";
    if (mode === "promote") {
        let preview: { path: string; change: string }[];
        try {
            preview = await gitHelper.previewStoryFiles(storyId);
        } catch (err) {
            vscode.window.showErrorMessage(String(err));
            return;
        }
        if (preview.length === 0) {
            vscode.window.showInformationMessage(`${storyId} has nothing new to promote to ${envUpper} — it's already up to date there.`);
            return;
        }
        const shown = preview.slice(0, 8).map(f => `  ${f.change === "added" ? "+" : f.change === "deleted" ? "-" : "~"} ${f.path}`);
        const more = preview.length > 8 ? `\n  ...and ${preview.length - 8} more` : "";
        filesBlock = `\n\n${preview.length} file(s):\n${shown.join("\n")}${more}`;
    }

    const confirmMsg = mode === "validate"
        ? `Validate ${storyId} against ${envUpper}?\n\nThis will:\n• Create ${promoBranch} from ${targetBranch}\n• Add your story's changes\n• Run a check-only validation against ${envUpper} (no deploy)`
        : `Promote & Deploy ${storyId} to ${envUpper}?\n\nThis will:\n• Create ${promoBranch} from ${targetBranch}\n• Add your story's changes\n• Open a PR (promotion → ${targetBranch})\n• Deploy to ${envUpper} once you approve & merge the PR${filesBlock}`;
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
                const outcome = await gitHelper.beginPromotion(storyId, targetEnv, mode, targetBranch);

                if (outcome.status === "conflict") {
                    const changedFiles = await storyChangedFiles(gitHelper, storyId);
                    const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);
                    await gitHelper.appendAudit({
                        operation: mode, storyId, targetEnv, outcome: "conflict",
                        summary: `Conflict preparing promotion branch for ${envUpper}`,
                        details: { changedFiles, packageXml, unmappedFiles, conflicts: outcome.conflicts },
                    });
                    await reportOperationConflict(gitHelper, outcome.conflicts, envUpper);
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
    const targetBranch    = findEnvironment(targetEnv)?.branch ?? targetEnv;
    progress?.report({ message: "Opening pull request page..." });

    await gitHelper.checkoutFeature(storyId);

    const changedFiles = await storyChangedFiles(gitHelper, storyId);
    const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);

    const repoOverride = await gitHelper.resolveRepoIdentity(bbClient);
    const prUrl = bbClient.buildPrUrl(promotionBranch, targetBranch, repoOverride);
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
    gitHelper: GitHelper,
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
        if (conflicts[0]) {
            const fileUri = vscode.Uri.joinPath(vscode.Uri.file(gitHelper.getWorkspaceRoot()), conflicts[0]);
            await vscode.window.showTextDocument(fileUri).then(undefined, () => {});
        }
        await vscode.commands.executeCommand("workbench.view.scm");
    }
}


