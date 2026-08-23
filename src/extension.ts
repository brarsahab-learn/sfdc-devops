// extension.ts — Main entry point for the Salesforce DevOps VS Code Extension

import * as vscode from "vscode";
import { StoryWebviewProvider }   from "./providers/StoryWebviewProvider";
import { CoverageWebviewProvider} from "./providers/CoverageWebviewProvider";
import { PipelineTreeProvider }   from "./providers/PipelineTreeProvider";
import { EnvironmentTreeProvider} from "./providers/EnvironmentTreeProvider";
import { startStory }      from "./commands/startStory";
import { commitAndPush }   from "./commands/submitForReview";
import { promoteStory }    from "./commands/promoteStory";
import { resumePromotion, cancelPromotion } from "./commands/resumePromotion";
import { syncBranch }      from "./commands/syncBranch";
import { createGitProviderClient } from "./GitProviderClient";
import { GitHelper }       from "./GitHelper";
import {
    getCurrentRole, findEnvironment, canPromote,
    isFeatureBranch, getBaseBranch, getStaleBranchThreshold,
} from "./config";

let pipelinePoller: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log("Salesforce DevOps extension activated");

    const bbClient  = createGitProviderClient(context);
    const gitHelper = new GitHelper();

    // Role controls which promote buttons are available — see sfDevops.roles and each
    // environment's requiredRole in sfDevops.environments. Developers leave sfDevops.role
    // at its default; a lead sets it to whatever role name their environments require.
    const userRole = getCurrentRole();

    // ── Register sidebar providers ───────────────────────────────────────────
    const storyProvider = new StoryWebviewProvider(
        context.extensionUri, bbClient, gitHelper, userRole
    );
    const coverageProvider = new CoverageWebviewProvider(
        context.extensionUri, gitHelper, storyProvider
    );
    const pipelineProvider = new PipelineTreeProvider(bbClient);
    const envProvider      = new EnvironmentTreeProvider(bbClient);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("sfDevopsStoryView", storyProvider),
        vscode.window.registerWebviewViewProvider("sfDevopsCoverageView", coverageProvider),
        vscode.window.registerTreeDataProvider("sfDevopsPipelineView", pipelineProvider),
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
            if (!canPromote(userRole, envCfg)) {
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
            pipelineProvider.refresh();
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
            storyProvider.refresh();
            vscode.window.showInformationMessage(`Switched to ${picked}`);
        }),

        vscode.commands.registerCommand("sfDevops.openSettings", () => {
            vscode.commands.executeCommand("workbench.action.openSettings", "sfDevops");
        })
    );

    // ── Poll pipeline status every 30 seconds ───────────────────────────────
    pipelinePoller = setInterval(() => { pipelineProvider.refresh(); }, 30_000);
    context.subscriptions.push({
        dispose: () => { if (pipelinePoller) { clearInterval(pipelinePoller); } }
    });

    // ── Warn if feature branch is behind prod on startup ────────────────────
    checkBranchStaleness(gitHelper, storyProvider);

    pipelineProvider.refresh();
    envProvider.refresh();
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
    if (pipelinePoller) { clearInterval(pipelinePoller); }
}
