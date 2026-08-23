// prepare2gpBeta.ts — "SF-Ops: Prepare 2GP Beta from UAT" command.
// Admin-triggered: diffs UAT against the 2GP packaging baseline, segregates changed
// metadata into managed/unmanaged, generates release notes, bumps the package version,
// and opens a PR targeting the baseline. See PackagingEngine.ts for the mechanics.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper } from "../GitHelper";
import { prepare2gpBeta as runPrepare2gpBeta, BumpType } from "../PackagingEngine";
import {
    getCurrentRole, getPackagingRequiredRole, getPackageBaselineBranch,
    getPackagingSourceBranch, extractStoryId,
} from "../config";
import { buildPackageXml } from "../AuditLog";

export async function prepare2gpBetaCommand(
    providerClient: IGitProviderClient,
    gitHelper:      GitHelper
): Promise<void> {
    const requiredRole = getPackagingRequiredRole();
    if (requiredRole && getCurrentRole() !== requiredRole) {
        vscode.window.showWarningMessage(
            `Preparing a 2GP beta requires the "${requiredRole}" role (sfDevops.packagingRequiredRole). ` +
            `Your role is "${getCurrentRole()}".`
        );
        return;
    }

    if (await gitHelper.hasUncommittedChanges()) {
        vscode.window.showWarningMessage(
            "You have uncommitted changes in the workspace. Commit or stash them first — " +
            "this command creates and checks out a new branch."
        );
        return;
    }

    const baseline = getPackageBaselineBranch();
    const source   = getPackagingSourceBranch();

    const bumpPick = await vscode.window.showQuickPick(
        [
            { label: "Patch", description: "1.2.3 → 1.2.4 (default)", value: "patch" as BumpType },
            { label: "Minor", description: "1.2.3 → 1.3.0", value: "minor" as BumpType },
            { label: "Major", description: "1.2.3 → 2.0.0", value: "major" as BumpType },
        ],
        { title: "2GP Beta version bump", placeHolder: "How should the package version increment?" }
    );
    if (!bumpPick) { return; }

    const confirm = await vscode.window.showWarningMessage(
        `Prepare a 2GP beta from ${source.toUpperCase()}?\n\n` +
        `This will:\n` +
        `• Compare origin/${source} against origin/${baseline}\n` +
        `• Create 2gp-beta/v<version> from origin/${baseline}\n` +
        `• Segregate changed metadata into managed/unmanaged\n` +
        `• Generate release notes and bump the package version (${bumpPick.label.toLowerCase()})\n` +
        `• Commit, push, and open a PR targeting ${baseline}`,
        { modal: true },
        "Yes, prepare beta"
    );
    if (!confirm) { return; }

    const originalBranch = await gitHelper.currentBranch();

    await vscode.window.withProgress(
        {
            location:    vscode.ProgressLocation.Notification,
            title:       "Preparing 2GP beta from UAT…",
            cancellable: false,
        },
        async (progress) => {
            try {
                const result = await runPrepare2gpBeta(
                    gitHelper,
                    providerClient,
                    bumpPick.value,
                    extractStoryId,
                    (message) => progress.report({ message })
                );

                const summary =
                    `✅ ${result.branch} pushed — ${result.managedFiles.length} managed, ` +
                    `${result.unmanagedFiles.length} unmanaged, ${result.excludedFiles.length} excluded. ` +
                    `Release notes: ${result.releaseNotesPath}.`;

                const changedFiles = [
                    ...result.managedFiles.map(path => ({ path, change: "modified" as const })),
                    ...result.unmanagedFiles.map(path => ({ path, change: "modified" as const })),
                    ...result.deletedFiles.map(path => ({ path, change: "deleted" as const })),
                ];
                const { xml: packageXml, unmapped: unmappedFiles } = buildPackageXml(changedFiles);
                await gitHelper.appendAudit({
                    operation: "prepare2gpBeta", branch: result.branch, outcome: "success",
                    summary: `${result.branch} pushed (v${result.version})`,
                    details: {
                        version: result.version, releaseNotesPath: result.releaseNotesPath,
                        prUrl: result.prUrl, changedFiles, packageXml, unmappedFiles,
                    },
                });

                if (result.prUrl) {
                    const choice = await vscode.window.showInformationMessage(summary, "Open PR");
                    if (choice === "Open PR") {
                        await vscode.env.openExternal(vscode.Uri.parse(result.prUrl));
                    }
                } else {
                    vscode.window.showWarningMessage(
                        `${summary} Could not determine a PR URL — open one manually for ${result.branch} → ${baseline}.`
                    );
                }
            } catch (err) {
                await gitHelper.appendAudit({
                    operation: "prepare2gpBeta", outcome: "failure",
                    summary: "Prepare 2GP Beta failed",
                    details: { error: String(err) },
                });
                vscode.window.showErrorMessage(`Prepare 2GP Beta failed: ${err}`);
            } finally {
                // Best-effort return to wherever the user was — this command isn't part of
                // the feature-branch workflow, so there's no "checkoutFeature" equivalent.
                if (originalBranch) { await gitHelper.checkoutBranch(originalBranch).catch(() => {}); }
            }
        }
    );
}
