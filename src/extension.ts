// extension.ts — Main entry point for the Salesforce DevOps VS Code Extension

import * as vscode from "vscode";
import { StoryWebviewProvider }   from "./providers/StoryWebviewProvider";
import { CoverageWebviewProvider} from "./providers/CoverageWebviewProvider";
import { EnvironmentTreeProvider} from "./providers/EnvironmentTreeProvider";
import { startStory }      from "./commands/startStory";
import { commitAndPush }   from "./commands/submitForReview";
import { promoteStory }    from "./commands/promoteStory";
import { resumePromotion, cancelPromotion } from "./commands/resumePromotion";
import { syncBranch }      from "./commands/syncBranch";
import { prepare2gpBetaCommand } from "./commands/prepare2gpBeta";
import { createGitProviderClient } from "./GitProviderClient";
import { GitHelper }       from "./GitHelper";
import { DeploymentDashboardPanel } from "./providers/DeploymentDashboardPanel";
import { AuditTrailPanel } from "./providers/AuditTrailPanel";
import {
    findEnvironment, canPromote, getRoles,
    isFeatureBranch, getBaseBranch, getStaleBranchThreshold, getPromotableEnvironments,
} from "./config";
import { getEffectiveRole, canAccessConfig, promptChangeRole } from "./RoleManager";
import { initLog } from "./Log";

let deployPoller:    NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext) {
    console.log("Salesforce DevOps extension activated");
    initLog(context);

    const gitHelper = new GitHelper();
    // sfDevops.gitProvider is optional — when it's left unset, pick the provider from the
    // origin remote's host instead of silently defaulting to Bitbucket, so a GitHub-origin
    // repo still resolves PR/pipeline status correctly out of the box.
    const remoteUrl = await gitHelper.getRemoteUrl();
    const bbClient  = createGitProviderClient(context, remoteUrl);

    // Role controls which promote buttons/config-management UI are available — see
    // sfDevops.roles and each environment's requiredRole in sfDevops.environments.
    // Resolved fresh via RoleManager on every check, not captured once here, since
    // "Change Role" can update it at runtime.

    // ── Register sidebar providers ───────────────────────────────────────────
    const storyProvider = new StoryWebviewProvider(
        context.extensionUri, bbClient, gitHelper, context
    );
    const coverageProvider = new CoverageWebviewProvider(
        context.extensionUri, gitHelper, storyProvider
    );
    const envProvider      = new EnvironmentTreeProvider(gitHelper);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("sfDevopsStoryView", storyProvider),
        vscode.window.registerWebviewViewProvider("sfDevopsCoverageView", coverageProvider),
        vscode.window.registerTreeDataProvider("sfDevopsEnvView", envProvider)
    );

    // ── Register commands ────────────────────────────────────────────────────
    context.subscriptions.push(

        vscode.commands.registerCommand("sfDevops.startStory", async () => {
            await startStory(bbClient, gitHelper, storyProvider);
        }),

        // Commit & Publish Feature Branch — ALL roles. Commits the staged metadata,
        // pushes the feature branch, then cherry-picks the story onto the dev branch.
        // No Dev org deploy.
        vscode.commands.registerCommand("sfDevops.commitAndPush", async () => {
            await commitAndPush(bbClient, gitHelper, storyProvider);
        }),

        // Validate Only — any configured environment, ALL roles. Creates the validate
        // branch and runs a check-only validation. Never gated by role.
        vscode.commands.registerCommand("sfDevops.validateEnv", async (env: string) => {
            await promoteStory(bbClient, gitHelper, env, "validate", storyProvider);
        }),

        // Promote & Deploy — any configured environment. Gated by that environment's
        // requiredRole (sfDevops.environments[].requiredRole), if any.
        vscode.commands.registerCommand("sfDevops.promoteEnv", async (env: string) => {
            const envCfg = findEnvironment(env);
            if (!envCfg) {
                vscode.window.showErrorMessage(`Unknown environment "${env}" — check sfDevops.environments.`);
                return;
            }
            if (!canPromote(getEffectiveRole(context), envCfg)) {
                vscode.window.showWarningMessage(
                    `Promoting to ${envCfg.label} requires the "${envCfg.requiredRole}" role. ` +
                    `Contact someone with that role to promote this story.`
                );
                return;
            }
            await promoteStory(bbClient, gitHelper, env, "promote", storyProvider);
        }),

        // Resume / cancel a paused cherry-pick (dev-publish or promotion) after conflicts.
        vscode.commands.registerCommand("sfDevops.resumePromotion", async () => {
            await resumePromotion(bbClient, gitHelper, storyProvider);
        }),

        vscode.commands.registerCommand("sfDevops.cancelPromotion", async () => {
            await cancelPromotion(gitHelper, storyProvider);
        }),

        vscode.commands.registerCommand("sfDevops.viewPipelineStatus", () => {
            envProvider.refresh();
        }),

        vscode.commands.registerCommand("sfDevops.syncBranch", async () => {
            await syncBranch(gitHelper, storyProvider);
        }),

        // Resume a previous story — lists all local feature branches to switch to
        vscode.commands.registerCommand("sfDevops.resumeStory", async () => {
            const branches = await gitHelper.listFeatureBranches();
            if (branches.length === 0) {
                vscode.window.showInformationMessage("No feature branches found.");
                return;
            }
            const picked = await vscode.window.showQuickPick(branches, {
                placeHolder: "Select a story branch to resume",
                title: "Resume Story"
            });
            if (!picked) { return; }
            await gitHelper.checkoutBranch(picked);
            await gitHelper.appendAudit({
                operation: "resumeStory", branch: picked, outcome: "success",
                summary: `Switched to ${picked}`,
            });
            storyProvider.refresh();
            vscode.window.showInformationMessage(`Switched to ${picked}`);
        }),

        vscode.commands.registerCommand("sfDevops.openSettings", () => {
            if (!canAccessConfig(getEffectiveRole(context))) {
                vscode.window.showWarningMessage("Only Admins can open Salesforce DevOps configuration.");
                return;
            }
            vscode.commands.executeCommand("workbench.action.openSettings", "sfDevops");
        }),

        vscode.commands.registerCommand("sfDevops.viewAuditLog", () => {
            AuditTrailPanel.createOrShow(gitHelper);
        }),

        vscode.commands.registerCommand("sfDevops.openDeploymentDashboard", (focusEnv?: string) => {
            DeploymentDashboardPanel.createOrShow(gitHelper, context, focusEnv);
        }),

        vscode.commands.registerCommand("sfDevops.changeRole", async () => {
            const changed = await promptChangeRole(context, getRoles());
            if (changed) { storyProvider.refresh(); }
        }),

        // Dedicated 2GP Release Gate — occasional, admin-triggered, separate from the
        // day-to-day sprint commands above. See PackagingEngine.ts.
        vscode.commands.registerCommand("sfDevops.prepare2gpBeta", async () => {
            await prepare2gpBetaCommand(bbClient, gitHelper, context);
        })
    );

    // ── Poll for merges pending deployment every 60 seconds ─────────────────
    // No external CI/webhook — this is what notices a merge landed on an env branch and
    // hasn't been deployed via the Deployment Dashboard yet.
    deployPoller = setInterval(() => { checkPendingDeployments(gitHelper); }, 60_000);
    context.subscriptions.push({
        dispose: () => { if (deployPoller) { clearInterval(deployPoller); } }
    });

    // ── Warn if feature branch is behind prod on startup ────────────────────
    checkBranchStaleness(gitHelper, storyProvider);

    envProvider.refresh();
}

async function checkPendingDeployments(gitHelper: GitHelper): Promise<void> {
    try {
        await gitHelper.fetchRemote();
        for (const env of getPromotableEnvironments()) {
            const currentSha = await gitHelper.remoteHeadSha(env.branch);
            if (!currentSha) { continue; }
            const lastNotified = await gitHelper.getLastNotifiedSha(env.name);
            if (lastNotified === currentSha) { continue; }  // already notified for this state

            const lastDeploy = await gitHelper.getDeployState(env.name);
            if (lastDeploy?.sha === currentSha) {
                await gitHelper.setLastNotifiedSha(env.name, currentSha);  // caught up, nothing pending
                continue;
            }

            await gitHelper.setLastNotifiedSha(env.name, currentSha);
            const choice = await vscode.window.showInformationMessage(
                `📦 New merge on ${env.label} — pending deployment.`,
                "Open Dashboard"
            );
            if (choice === "Open Dashboard") {
                await vscode.commands.executeCommand("sfDevops.openDeploymentDashboard");
            }
            DeploymentDashboardPanel.refreshIfOpen();
        }
    } catch { /* offline or transient — try again next tick */ }
}

async function checkBranchStaleness(
    gitHelper:     GitHelper,
    storyProvider: StoryWebviewProvider
): Promise<void> {
    const branch = await gitHelper.currentBranch();
    if (!isFeatureBranch(branch)) { return; }
    const base = getBaseBranch();
    const threshold = getStaleBranchThreshold();
    const behindCount = await gitHelper.commitsBehind(branch!, `origin/${base}`);
    if (behindCount > threshold) {
        const action = await vscode.window.showWarningMessage(
            `⚠️ Your branch is ${behindCount} commits behind ${base}. Sync to avoid conflicts?`,
            "Sync Now", "Later"
        );
        if (action === "Sync Now") {
            await vscode.commands.executeCommand("sfDevops.syncBranch");
        }
    }
}

export function deactivate() {
    if (deployPoller) { clearInterval(deployPoller); }
}
