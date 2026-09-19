// extension.ts — Main entry point for the Salesforce-DevOps VS Code Extension

import * as vscode from "vscode";
import { StoryWebviewProvider, StoryStatusInfo }   from "./providers/StoryWebviewProvider";
import { CoveragePanel } from "./providers/CoveragePanel";
import { EnvironmentTreeProvider} from "./providers/EnvironmentTreeProvider";
import { startStory }      from "./commands/startStory";
import { commitAndPush }   from "./commands/submitForReview";
import { promoteStory }    from "./commands/promoteStory";
import { promoteViaPicker } from "./commands/promotePicker";
import { resumePromotion, cancelPromotion } from "./commands/resumePromotion";
import { syncBranch }      from "./commands/syncBranch";
import { prepare2gpBetaCommand } from "./commands/prepare2gpBeta";
import { createGitProviderClient } from "./GitProviderClient";
import { GitHelper, warnUncommittedChanges } from "./GitHelper";
import { GitRefContentProvider, SF_DEVOPS_DIFF_SCHEME } from "./DiffContentProvider";
import { DeploymentDashboardPanel } from "./providers/DeploymentDashboardPanel";
import { AuditTrailPanel } from "./providers/AuditTrailPanel";
import { StoryPipelinePanel } from "./providers/StoryPipelinePanel";
import { StoryJourneyPanel } from "./providers/StoryJourneyPanel";
import { AdminPanel } from "./providers/AdminPanel";
import { DiffViewerPanel } from "./providers/DiffViewerPanel";
import {
    findEnvironment, canPromote, getRoles,
    isFeatureBranch, getBaseBranch, getStaleBranchThreshold, getPromotableEnvironments,
    initOrgAliasStore, getPublishEnvironment, getAuditLogRetentionDays,
} from "./config";
import { getEffectiveRole, canAccessConfig, promptChangeRole, migrateRolePasswordIfNeeded, resetRolePassword, resetRolePasswordForce } from "./RoleManager";
import { initLog } from "./Log";
import { watchGitState } from "./GitWatcher";
import { execSf } from "./SfCli";
import { EnvItem } from "./providers/EnvironmentTreeProvider";

let deployPoller:    NodeJS.Timeout | undefined;
let _pollFailCount   = 0;
let _pollIntervalMs  = 60_000;
const POLL_MIN_MS    = 60_000;
const POLL_MAX_MS    = 600_000;
const POLL_FAIL_CAP  = 3;

async function runPoll(gitHelper: GitHelper, context: vscode.ExtensionContext): Promise<void> {
    try {
        await checkPendingDeployments(gitHelper, context);
        // Success — reset backoff toward minimum (step down one level).
        _pollFailCount = 0;
        _pollIntervalMs = POLL_MIN_MS;
    } catch {
        _pollFailCount = Math.min(_pollFailCount + 1, POLL_FAIL_CAP);
        // Double the interval each failure, capped at POLL_MAX_MS.
        _pollIntervalMs = Math.min(POLL_MIN_MS * Math.pow(2, _pollFailCount), POLL_MAX_MS);
    }
}

export async function activate(context: vscode.ExtensionContext) {
    console.log("Salesforce-DevOps extension activated");
    initLog(context);
    initOrgAliasStore(context);
    await migrateRolePasswordIfNeeded(context);

    const gitHelper = new GitHelper();

    // Auto-trim audit log on startup using configured retention window.
    const retentionDays = getAuditLogRetentionDays();
    if (retentionDays > 0) {
        const trimmed = await gitHelper.trimAuditLog(retentionDays * 24 * 60 * 60 * 1000);
        if (trimmed > 0) {
            console.log(`Salesforce-DevOps: auto-trimmed ${trimmed} audit entries older than ${retentionDays} days.`);
        }
    }

    // sfDevops.gitProvider is optional — when it's left unset, pick the provider from the
    // origin remote's host instead of silently defaulting to Bitbucket, so a GitHub-origin
    // repo still resolves PR/pipeline status correctly out of the box.
    const remoteUrl = await gitHelper.getRemoteUrl();
    const bbClient  = createGitProviderClient(context, remoteUrl);

    // Backs "Review Changes" (Promote/Validate confirm) with real VS Code diff editors —
    // content comes straight from git refs, no checkout needed for either side.
    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SF_DEVOPS_DIFF_SCHEME, new GitRefContentProvider(gitHelper))
    );

    // Role controls which promote buttons/config-management UI are available — see
    // sfDevops.roles and each environment's requiredRole in sfDevops.environments.
    // Resolved fresh via RoleManager on every check, not captured once here, since
    // "Change Role" can update it at runtime.

    // ── Status bar item — always visible (muted when idle) so "where am I" doesn't depend
    // on the sidebar being open or scrolled to the right spot. Fed by StoryWebviewProvider's
    // own refresh() via the onStatusChange callback below, so it can never show something the
    // sidebar itself disagrees with.
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.command = "sfDevopsStoryView.focus";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Org identity leads the text when it's known — "which org am I about to touch" is meant
    // as an instant, passive sanity check before every change, so it has to be the first
    // thing visible, not buried after the story id. 🟢/🚨 prefixes carry the cue on their own
    // regardless of theme; the Prod case ALSO gets VS Code's own error-toned status bar
    // background so it's unmissable even to someone not parsing the emoji.
    const updateStatusBar = (info: StoryStatusInfo | null) => {
        if (!info) {
            statusBarItem.text = "$(circle-slash) No active story";
            statusBarItem.tooltip = "Salesforce-DevOps — no feature branch checked out";
            statusBarItem.backgroundColor = undefined;
            return;
        }
        const stage = info.stage;
        const stageText = stage ? `${info.storyId} · ${stage.label} next` : `${info.storyId} · complete`;
        if (stage?.orgAlias) {
            const cue = stage.isProd ? "🚨" : "🟢";
            statusBarItem.text = `${cue} ${stage.orgAlias} — ${stageText}`;
            statusBarItem.backgroundColor = stage.isProd
                ? new vscode.ThemeColor("statusBarItem.errorBackground")
                : undefined;
        } else {
            statusBarItem.text = stage ? `$(rocket) ${stageText}` : `$(check) ${stageText}`;
            statusBarItem.backgroundColor = undefined;
        }
        statusBarItem.tooltip = stage
            ? `${info.branch}\nNext stage: ${stage.label}${stage.orgAlias ? ` (${stage.orgAlias})` : " — no org alias configured"}${stage.isProd ? "\n⚠ This is Production." : ""}`
            : `${info.branch}\nEvery stage deployed`;
    };
    updateStatusBar(null);

    // ── Register sidebar providers ───────────────────────────────────────────
    const storyProvider = new StoryWebviewProvider(
        context.extensionUri, bbClient, gitHelper, context, updateStatusBar
    );
    const envProvider = new EnvironmentTreeProvider(gitHelper);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("sfDevopsStoryView", storyProvider),
        vscode.window.registerTreeDataProvider("sfDevopsEnvView", envProvider)
    );

    // ── Live git-state awareness — react immediately to a branch switch, commit, or
    // staged/unstaged change made OUTSIDE this extension's own buttons (Source Control,
    // terminal, another tool), instead of waiting up to sfDevops.fallbackRefreshSeconds for
    // the sidebar's own poll to notice. Degrades to a no-op if the built-in git extension
    // isn't available — the fallback timer keeps working unchanged either way.
    context.subscriptions.push(
        watchGitState(gitHelper.getWorkspaceRoot(), () => {
            storyProvider.refresh();
            envProvider.refresh();
        })
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
        // `env` is optional — the Story Progress sidebar always passes one (the ONE stage
        // that story itself needs next), but that button disappears once your current
        // story is past that stage even though a DIFFERENT story might still need
        // promoting there. Command Palette / a toolbar button call this with no argument,
        // so prompt for which environment first instead of failing on "unknown environment
        // undefined" — the picker after that already handles "which story" independently
        // of whatever's currently checked out.
        vscode.commands.registerCommand("sfDevops.promoteEnv", async (env?: string) => {
            if (!env) {
                const role = getEffectiveRole(context);
                const choices = getPromotableEnvironments().filter(e => canPromote(role, e));
                if (choices.length === 0) {
                    vscode.window.showWarningMessage("Your role can't promote into any configured environment.");
                    return;
                }
                const picked = await vscode.window.showQuickPick(
                    choices.map(e => ({ label: e.label, env: e.name })),
                    { title: "Promote to which environment?", placeHolder: "Select the target environment" }
                );
                if (!picked) { return; }
                env = picked.env;
            }

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
            await promoteViaPicker(bbClient, gitHelper, env, storyProvider);
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

            if (await gitHelper.hasUncommittedChanges()) {
                await warnUncommittedChanges(gitHelper, `Commit or stash your local changes before switching to ${picked} — checking out a different branch needs a clean working tree.`);
                return;
            }

            try {
                await gitHelper.checkoutBranch(picked);
            } catch (err) {
                vscode.window.showErrorMessage(`Could not switch to ${picked}: ${err}`);
                return;
            }
            await gitHelper.appendAudit({
                operation: "resumeStory", branch: picked, outcome: "success",
                summary: `Switched to ${picked}`,
            });
            storyProvider.refresh();
            vscode.window.showInformationMessage(`Switched to ${picked}`);
        }),

        vscode.commands.registerCommand("sfDevops.openSettings", () => {
            if (!canAccessConfig(getEffectiveRole(context))) {
                vscode.window.showWarningMessage("Only Admins can open Salesforce-DevOps configuration.");
                return;
            }
            vscode.commands.executeCommand("workbench.action.openSettings", "sfDevops");
        }),

        vscode.commands.registerCommand("sfDevops.viewAuditLog", () => {
            AuditTrailPanel.createOrShow(gitHelper);
        }),

        // The dashboard is always bound to exactly one environment (see
        // DeploymentDashboardPanel._boundEnv) — every real call site already passes one, but
        // this command is also Command-Palette-visible, so prompt when it isn't given one
        // rather than silently guessing, same pattern sfDevops.promoteEnv already uses.
        vscode.commands.registerCommand("sfDevops.openDeploymentDashboard", async (env?: string) => {
            if (!env) {
                const choices = [getPublishEnvironment(), ...getPromotableEnvironments()];
                const picked = await vscode.window.showQuickPick(
                    choices.map(e => ({ label: e.label, env: e.name })),
                    { title: "Open the Deployment Dashboard for which environment?", placeHolder: "Select an environment" }
                );
                if (!picked) { return; }
                env = picked.env;
            }
            DeploymentDashboardPanel.createOrShow(gitHelper, context, env);
        }),

        // Inline "view" icon on each Environments tree row (package.json's view/item/context,
        // scoped to EnvItem's contextValue) — `sf org open` launches the org in the browser
        // using its own authenticated session (frontdoor.jsp under the hood), landing
        // straight on the Deploy Status page instead of the default home page.
        vscode.commands.registerCommand("sfDevops.openEnvOrgDeployStatus", async (item?: EnvItem) => {
            if (!item?.orgAlias) {
                vscode.window.showWarningMessage(
                    `No org alias set for ${item?.envLabel ?? "this environment"} — set sfDevops.environments[].orgAlias to enable this.`
                );
                return;
            }
            try {
                await execSf(
                    ["org", "open", "--target-org", item.orgAlias, "--path", "lightning/setup/DeployStatus/home"],
                    { cwd: gitHelper.getWorkspaceRoot(), timeout: 30_000, maxBuffer: 2 * 1024 * 1024 }
                );
            } catch (err: any) {
                vscode.window.showErrorMessage(
                    `Could not open "${item.orgAlias}" — it may not be authenticated yet. (${err?.message ?? err})`
                );
            }
        }),

        vscode.commands.registerCommand("sfDevops.changeRole", async () => {
            const changed = await promptChangeRole(context, getRoles(), gitHelper);
            if (changed) { storyProvider.refresh(); }
        }),

        vscode.commands.registerCommand("sfDevops.resetRolePassword", async () => {
            await resetRolePassword(context, gitHelper);
        }),

        vscode.commands.registerCommand("sfDevops.resetRolePasswordForce", async () => {
            await resetRolePasswordForce(context, gitHelper);
        }),

        vscode.commands.registerCommand("sfDevops.openPipelineView", () => {
            StoryPipelinePanel.createOrShow(gitHelper);
        }),

        vscode.commands.registerCommand("sfDevops.openStoryJourney", (_storyId?: string) => {
            StoryJourneyPanel.createOrShow(gitHelper, _storyId);
        }),

        vscode.commands.registerCommand("sfDevops.openAdminPanel", () => {
            AdminPanel.createOrShow(gitHelper, bbClient, context);
        }),

        vscode.commands.registerCommand("sfDevops.openDiffViewer", (fromRef?: string, toRef?: string) => {
            DiffViewerPanel.createOrShow(gitHelper, fromRef, toRef);
        }),

        // Opens the Coverage panel on the right — also triggered automatically when coverage
        // is blocking a promotion (focusCoverage link in the sidebar warning banner).
        vscode.commands.registerCommand("sfDevops.runCoverage", async () => {
            CoveragePanel.createOrShow(gitHelper, storyProvider);
        }),

        // "Stories Pending My Action" — surfaced as a QuickPick so users can jump directly
        // to whichever story is waiting for them (promote, sign off, deploy) without hunting
        // through the sidebar or remembering which env each story is stuck in.
        vscode.commands.registerCommand("sfDevops.viewPendingActions", async () => {
            await viewPendingActions(gitHelper, context);
        }),

        // Dedicated 2GP Release Gate — occasional, admin-triggered, separate from the
        // day-to-day sprint commands above. See PackagingEngine.ts.
        vscode.commands.registerCommand("sfDevops.prepare2gpBeta", async () => {
            await prepare2gpBetaCommand(bbClient, gitHelper, context);
        })
    );

    // ── Poll for merges pending deployment — self-rescheduling with exponential backoff
    // No external CI/webhook — this notices a merge landing on an env branch that
    // hasn't been deployed yet. Backs off on repeated failures (offline / transient).
    function schedulePoll() {
        deployPoller = setTimeout(async () => {
            await runPoll(gitHelper, context);
            schedulePoll();
        }, _pollIntervalMs);
    }
    schedulePoll();
    context.subscriptions.push({
        dispose: () => { if (deployPoller) { clearTimeout(deployPoller); } }
    });

    // ── Warn if feature branch is behind prod on startup ────────────────────
    checkBranchStaleness(gitHelper, storyProvider);

    envProvider.refresh();
}

async function checkPendingDeployments(gitHelper: GitHelper, context: vscode.ExtensionContext): Promise<void> {
    // Deployment notifications are only relevant for roles that can act on them.
    // Developers get no deploy access, so don't interrupt them with poller noise.
    const role = getEffectiveRole(context);
    const canDeploy = role === "Lead" || role === "Admin";

    await gitHelper.fetchRemote();
    // Ground rule: a promotion branch you're already tracking locally should never look
    // stale just because it moved on the remote — keep every one of them current every
    // tick, independent of whether anything merged this round.
    await gitHelper.syncLocalPromotionBranches();

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
        // Ground rule: once a promotion merges, pull it on local too — a fast-forward-only
        // sync of the env branch's own local ref, never touching anything you haven't
        // committed (see GitHelper.syncLocalRef).
        await gitHelper.syncLocalRef(env.branch);

        DeploymentDashboardPanel.refreshIfOpen();

        if (!canDeploy) { continue; }  // refresh open panels silently for non-deployers

        // Build a summary: how many stories merged since last deploy.
        const storyNames = await gitHelper.groupChangesByStory(env.branch, lastNotified ?? undefined);
        const count = storyNames.length;
        const label = count === 1
            ? `${storyNames[0]}`
            : count > 1 ? `${count} stories` : "changes";

        const choice = await vscode.window.showInformationMessage(
            `📦 ${env.label}: ${label} merged — pending deployment.`,
            "Open Dashboard"
        );
        if (choice === "Open Dashboard") {
            await vscode.commands.executeCommand("sfDevops.openDeploymentDashboard", env.name);
        }
    }
}

/**
 * Shows a QuickPick of every remote feature branch that has a pending action for the
 * current role: stories ready to promote (Lead/Admin), stories with pending deployment
 * notifications, or stories awaiting a signoff. Selecting an item checks out that branch.
 */
async function viewPendingActions(
    gitHelper: GitHelper,
    context: vscode.ExtensionContext
): Promise<void> {
    const role        = getEffectiveRole(context);
    const remoteBranches = await gitHelper.listRemoteFeatureBranches().catch(() => [] as string[]);

    interface ActionItem extends vscode.QuickPickItem {
        branch: string;
    }

    const items: ActionItem[] = [];
    const envs = getPromotableEnvironments();

    for (const branch of remoteBranches) {
        const actions: string[] = [];

        for (const env of envs) {
            if (!canPromote(role, env)) { continue; }
            const sha = await gitHelper.remoteHeadSha(env.branch).catch(() => null);
            const lastDeploy = sha ? await gitHelper.getDeployState(env.name).catch(() => null) : null;
            if (sha && lastDeploy?.sha !== sha) {
                actions.push(`⚡ Pending deploy → ${env.label}`);
            }
        }

        if (actions.length > 0) {
            items.push({
                label:       `$(git-branch) ${branch}`,
                description: actions.join("  ·  "),
                branch,
            });
        }
    }

    if (items.length === 0) {
        vscode.window.showInformationMessage("No stories are currently waiting for your action.");
        return;
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: "Stories Pending My Action",
        placeHolder: "Select a story to check it out",
    });
    if (!picked) { return; }

    if (await gitHelper.hasUncommittedChanges()) {
        const { warnUncommittedChanges } = await import("./GitHelper");
        await warnUncommittedChanges(gitHelper, `Commit or stash your changes before switching to ${picked.branch}.`);
        return;
    }
    await gitHelper.checkoutBranch(picked.branch).catch(err => {
        vscode.window.showErrorMessage(`Could not switch to ${picked.branch}: ${err}`);
    });
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
    if (deployPoller) { clearTimeout(deployPoller); }
}
