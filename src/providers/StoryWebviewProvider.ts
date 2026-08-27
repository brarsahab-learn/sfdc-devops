// StoryWebviewProvider.ts
// Renders the main "Current Story" panel in the sidebar.
// Shows story progress across all environments + action buttons.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper, PendingOp } from "../GitHelper";
import {
    extractStoryId, isFeatureBranch, getBaseBranch, getEnvironments, getPublishEnvironment,
    getPromotableEnvironments, canPromote, getTerminalStageMessage, promoBranchName, buildTicketUrl,
    getCoverageGateEnvironment, getOrgAliasSlots, setOrgAliasSlot, OrgAliasSlot,
} from "../config";
import { runSetupChecks, SetupCheckItem } from "../SetupCheck";
import { getEffectiveRole, canAccessConfig } from "../RoleManager";
import { isOrgConnected } from "../SfCli";

const SETUP_CONFIRMED_KEY = "sfDevops.setupConfirmed";
const AUTO_REFRESH_SECONDS = 60;

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

export class StoryWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "sfDevopsStoryView";
    private _view?: vscode.WebviewView;
    private _forceShowSetup = false;
    private _autoRefreshTimer?: NodeJS.Timeout;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _bbClient: IGitProviderClient,
        private readonly _gitHelper: GitHelper,
        private readonly _extContext: vscode.ExtensionContext
    ) {}

    /** Resolved fresh on every use — "Change Role" can update this at runtime, so it must never be cached. */
    private get _userRole(): string {
        return getEffectiveRole(this._extContext);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getLoadingHtml();

        // Handle messages from webview
        webviewView.webview.onDidReceiveMessage(async (msg: { command: string; env?: string; key?: string; value?: string }) => {
            switch (msg.command) {
                case "resumeStory":
                    vscode.commands.executeCommand("sfDevops.resumeStory"); break;
                case "startStory":
                    vscode.commands.executeCommand("sfDevops.startStory"); break;
                case "commitAndPush":
                    vscode.commands.executeCommand("sfDevops.commitAndPush"); break;
                case "promote":
                    if (msg.env) { vscode.commands.executeCommand("sfDevops.promoteEnv", msg.env); }
                    break;
                case "validate":
                    if (msg.env) { vscode.commands.executeCommand("sfDevops.validateEnv", msg.env); }
                    break;
                case "resumePromotion":
                    vscode.commands.executeCommand("sfDevops.resumePromotion"); break;
                case "cancelPromotion":
                    vscode.commands.executeCommand("sfDevops.cancelPromotion"); break;
                case "syncBranch":
                    vscode.commands.executeCommand("sfDevops.syncBranch"); break;
                case "refresh":
                    this.refresh(); break;
                case "viewAuditLog":
                    vscode.commands.executeCommand("sfDevops.viewAuditLog"); break;
                case "openDeploymentDashboard":
                    vscode.commands.executeCommand("sfDevops.openDeploymentDashboard", msg.env); break;
                case "changeRole":
                    vscode.commands.executeCommand("sfDevops.changeRole"); break;
                case "viewBranchInBrowser":
                    await this._viewBranchInBrowser(); break;
                case "focusCoverage":
                    vscode.commands.executeCommand("sfDevopsCoverageView.focus"); break;
                case "recheckSetup":
                    this.refresh(); break;
                case "openSetupCheck":
                    this._forceShowSetup = true;
                    this.refresh();
                    break;
                case "closeSetupCheck":
                    this._forceShowSetup = false;
                    this.refresh();
                    break;
                case "confirmSetup":
                    this._forceShowSetup = false;
                    await this._extContext.workspaceState.update(SETUP_CONFIRMED_KEY, true);
                    this.refresh();
                    break;
                case "saveOrgAlias":
                    if (msg.key && canAccessConfig(this._userRole)) {
                        await setOrgAliasSlot(msg.key as OrgAliasSlot["key"], (msg.value ?? "").trim());
                        this.refresh();
                    }
                    break;
                case "loginOrg":
                    if (msg.key && msg.value?.trim() && canAccessConfig(this._userRole)) {
                        const alias = msg.value.trim();
                        await setOrgAliasSlot(msg.key as OrgAliasSlot["key"], alias);
                        const alreadyConnected = await isOrgConnected(alias, this._gitHelper.getWorkspaceRoot());
                        if (alreadyConnected) {
                            vscode.window.showInformationMessage(`"${alias}" is already authenticated — no login needed.`);
                        } else {
                            const terminal = vscode.window.createTerminal(`sf org login: ${alias}`);
                            terminal.show();
                            terminal.sendText(`sf org login web --alias ${alias}`);
                        }
                        this.refresh();
                    }
                    break;
                case "recordSignoff":
                    if (msg.env) { await this._recordSignoff(msg.env); }
                    break;
            }
        });

        // Only poll while the panel is actually visible — no work happens while the
        // sidebar is collapsed or another view is focused. Rescheduled (not a fixed
        // interval) so a manual refresh always resets the countdown honestly.
        webviewView.onDidChangeVisibility(() => this._scheduleAutoRefresh());
        webviewView.onDidDispose(() => this._clearAutoRefresh());

        this.refresh();
    }

    private _clearAutoRefresh(): void {
        if (this._autoRefreshTimer) {
            clearTimeout(this._autoRefreshTimer);
            this._autoRefreshTimer = undefined;
        }
    }

    private _scheduleAutoRefresh(): void {
        this._clearAutoRefresh();
        if (this._view?.visible) {
            this._autoRefreshTimer = setTimeout(() => this.refresh(), AUTO_REFRESH_SECONDS * 1000);
        }
    }

    private async _viewBranchInBrowser(): Promise<void> {
        const branch = await this._gitHelper.currentBranch();
        if (!branch) { return; }
        const repoOverride = await this._gitHelper.resolveRepoIdentity(this._bbClient);
        const url = this._bbClient.buildBranchUrl(branch, repoOverride);
        if (!url) {
            vscode.window.showWarningMessage(
                "Could not determine the repo to open — set sfDevops.repoWorkspace and sfDevops.repoSlug."
            );
            return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(url));
    }

    public async refresh() {
        if (!this._view) { return; }

        try {
            // Basic setup must be validated (and, the first time, explicitly confirmed)
            // before anything else in this panel is shown.
            const checks = await runSetupChecks(this._gitHelper, this._bbClient, this._extContext);
            const requiredPassed = checks.filter(c => c.required).every(c => c.passed);
            const confirmed = this._extContext.workspaceState.get<boolean>(SETUP_CONFIRMED_KEY, false);

            if (!requiredPassed) {
                if (confirmed) { await this._extContext.workspaceState.update(SETUP_CONFIRMED_KEY, false); }
                this._view.webview.html = this._getSetupGateHtml(checks, false, false);
                return;
            }
            if (!confirmed) {
                this._view.webview.html = this._getSetupGateHtml(checks, true, false);
                return;
            }
            if (this._forceShowSetup) {
                this._view.webview.html = this._getSetupGateHtml(checks, true, true);
                return;
            }

            // A paused cherry-pick (conflict left for manual resolution) takes priority.
            const pending = await this._gitHelper.getPendingOperation();
            if (pending) {
                const conflicts = await this._gitHelper.unmergedFiles();
                this._view.webview.html = this._getConflictHtml(pending, conflicts);
                return;
            }

            const branch    = await this._gitHelper.currentBranch();
            const storyId   = extractStoryId(branch);
            const progress  = await this._getStoryProgress(storyId);
            const onFeature = isFeatureBranch(branch);
            const behind    = onFeature
                ? await this._gitHelper.commitsBehind(branch!, `origin/${getBaseBranch()}`)
                : 0;
            const localChanges = onFeature ? await this._getLocalChangesSummary() : null;
            const coverageBlockedEnv = await this._getCoverageBlockedEnv(storyId);
            const repoOverride = await this._gitHelper.resolveRepoIdentity(this._bbClient);

            const signoffPassed: Record<string, boolean> = {};
            if (storyId) {
                for (const env of getEnvironments()) {
                    signoffPassed[env.name] = env.signoffGate ? await this._gitHelper.isSignoffPassed(storyId, env.name) : true;
                }
            }

            this._view.webview.html = this._getWebviewHtml(
                branch ?? "No branch", storyId, progress, behind, coverageBlockedEnv, repoOverride, signoffPassed, localChanges
            );
        } catch (err) {
            this._view.webview.html = this._getErrorHtml(String(err));
        } finally {
            this._scheduleAutoRefresh();
        }
    }

    private async _getStoryProgress(storyId: string): Promise<Record<string, string>> {
        const progress: Record<string, string> = {};

        // Refresh remote refs so detection sees the latest pushes/merges.
        await this._gitHelper.fetchRemote();

        for (const env of getEnvironments()) {
            progress[env.name] = await this._getEnvState(storyId, env.name);
        }
        return progress;
    }

    /**
     * Resolves a story's state per environment (git-based, no token required).
     *   • the first configured environment (e.g. "dev") — "published" once the story's
     *     commit is on that environment's branch (published straight from the feature branch).
     *   • every later environment — "open" once its promotion/validate branch exists,
     *     "merged" once the PR has landed on the env's branch but this extension hasn't
     *     actually deployed that far yet, "deployed" once a real deploy through the
     *     Deployment Dashboard has caught up to (or passed) the story's commit, else "none".
     *     "merged" and "deployed" used to be the same state ("PR merged" was shown as
     *     "Deployed" outright) — that was wrong: merging a PR doesn't run `sf project
     *     deploy`, and conflating the two let the UI claim something was live in an org
     *     when nobody had actually deployed it there yet.
     */
    private async _getEnvState(storyId: string, env: string): Promise<string> {
        if (!storyId) { return "none"; }
        try {
            const publishEnv = getPublishEnvironment();
            if (env === publishEnv.name) {
                return (await this._gitHelper.branchContainsStory(publishEnv.branch, storyId)) ? "published" : "none";
            }

            const envCfg           = getEnvironments().find(e => e.name === env);
            const envBranch        = envCfg?.branch ?? env;
            const promotionBranch  = promoBranchName(storyId, env, "promote");
            const validateBranch   = promoBranchName(storyId, env, "validate");

            const storyCommitSha = await this._gitHelper.storyCommitShaOnBranch(envBranch, storyId);
            if (storyCommitSha) {
                const lastDeploy = await this._gitHelper.getDeployState(env);
                if (lastDeploy && await this._gitHelper.isAncestorSha(storyCommitSha, lastDeploy.sha)) {
                    return "deployed";
                }
                return "merged";
            }

            // A configured Bitbucket token can distinguish an open PR; otherwise use git.
            try {
                const api = await this._bbClient.getPRState(promotionBranch, envBranch);
                if (api === "merged") { return "merged"; }
                if (api === "open")   { return "open"; }
            } catch { /* no token — fall through */ }

            if (await this._gitHelper.remoteBranchExists(promotionBranch)
                || await this._gitHelper.remoteBranchExists(validateBranch)) { return "open"; }
            return "none";
        } catch {
            return "unknown";
        }
    }

    /**
     * The name of the next environment if it's coverage-gated and this story hasn't passed
     * that gate yet — used to proactively disable the Promote button instead of only
     * blocking it after the click (promoteStory.ts still enforces this server-side too).
     */
    private async _getCoverageBlockedEnv(storyId: string): Promise<string | null> {
        if (!storyId) { return null; }
        const gateEnv = getCoverageGateEnvironment();
        if (!gateEnv) { return null; }
        const apex = await this._gitHelper.featureApexClasses(storyId);
        if (apex.length === 0) { return null; }
        const passed = await this._gitHelper.isCoveragePassed(storyId);
        return passed ? null : gateEnv.name;
    }

    /**
     * Local working-tree changes not yet published to dev — surfaced so "DEV: Published"
     * doesn't silently go stale the moment you make another edit. `other` covers anything
     * uncommitted that isn't staged (unstaged edits, new untracked files); it's auto-preserved
     * via stash (not lost or silently swept in) if "Commit to Dev" is used while it's present.
     */
    private async _getLocalChangesSummary(): Promise<{ staged: number; other: number } | null> {
        const stagedList = await this._gitHelper.stagedFiles();
        const allChanged = await this._gitHelper.workingTreeFiles();
        const stagedSet  = new Set(stagedList);
        const other = allChanged.filter(f => !stagedSet.has(f)).length;
        return (stagedList.length === 0 && other === 0) ? null : { staged: stagedList.length, other };
    }

    /** Prompts for an optional sign-off note, records it, and logs it to the audit trail. */
    private async _recordSignoff(envName: string): Promise<void> {
        const branch  = await this._gitHelper.currentBranch();
        const storyId = extractStoryId(branch);
        if (!storyId) { return; }
        const env = getEnvironments().find(e => e.name === envName);

        const confirm = await vscode.window.showWarningMessage(
            `Record sign-off for ${storyId} on ${env?.label ?? envName}? This unlocks promoting to the next stage.`,
            { modal: true },
            "Yes, record sign-off"
        );
        if (!confirm) { return; }

        const note = await vscode.window.showInputBox({
            prompt: `Sign-off note for ${env?.label ?? envName} (optional)`,
            placeHolder: "e.g. All test scenarios pass, approved by Jane",
        });

        await this._gitHelper.recordSignoff(storyId, envName, note ? { note } : {});
        await this._gitHelper.appendAudit({
            operation: "signoff", storyId, targetEnv: envName, outcome: "success",
            summary: `Sign-off recorded for ${env?.label ?? envName}`,
            details: note ? { note } : undefined,
        });
        vscode.window.showInformationMessage(`✅ Sign-off recorded for ${env?.label ?? envName}.`);
        this.refresh();
    }

    private _getWebviewHtml(
        branch: string,
        storyId: string,
        progress: Record<string, string>,
        behindCount: number,
        coverageBlockedEnv: string | null,
        repoOverride: { workspace: string; repoSlug: string } | undefined,
        signoffPassed: Record<string, boolean>,
        localChanges: { staged: number; other: number } | null
    ): string {
        const onFeatureBranch = isFeatureBranch(branch);
        const baseBranch      = getBaseBranch();
        const environments    = getEnvironments();
        const publishEnv      = getPublishEnvironment();
        const promotable      = getPromotableEnvironments();

        const envRows = environments.map((envCfg) => {
            const state = progress[envCfg.name];
            let icon = "⏳", label = "Pending", color = "var(--vscode-descriptionForeground)";
            if (state === "published")  { icon = "✅"; label = "Published";              color = "var(--vscode-charts-green)"; }
            else if (state === "deployed") { icon = "✅"; label = "Deployed";            color = "var(--vscode-charts-green)"; }
            else if (state === "merged")   { icon = "⚡"; label = "Merged — ready to deploy"; color = "var(--vscode-charts-yellow)"; }
            else if (state === "open")  { icon = "🔄"; label = "Validated / In PR";       color = "var(--vscode-charts-blue)"; }

            // DEV already shows "Published", but there's more local work since then —
            // flag it explicitly instead of letting the badge quietly go stale.
            let newChangesNote = "";
            if (envCfg.name === publishEnv.name && state === "published" && localChanges) {
                icon = "⚠️"; color = "var(--vscode-charts-yellow)";
                const total = localChanges.staged + localChanges.other;
                label = `Published — ${total} new change(s) pending`;
                const parts: string[] = [];
                if (localChanges.staged > 0) { parts.push(`${localChanges.staged} staged`); }
                if (localChanges.other > 0)  { parts.push(`${localChanges.other} in progress (preserved automatically)`); }
                newChangesNote = `<div class="env-note">${parts.join(", ")} — <a href="#" onclick="send('commitAndPush')">commit to dev</a></div>`;
            }

            let actionLink = "";
            if (state === "open" && storyId) {
                const promotionBranch = promoBranchName(storyId, envCfg.name, "promote");
                const prUrl = this._bbClient.buildPrUrl(promotionBranch, envCfg.branch, repoOverride);
                if (prUrl) {
                    actionLink = `<a href="${prUrl}" title="Open PR in browser to review it" style="margin-right:2px">🔗</a>`;
                }
            } else if (state === "merged") {
                actionLink = `<a href="#" title="Deploy this to ${envCfg.label} now" style="margin-right:2px" onclick="send('openDeploymentDashboard', '${envCfg.name}')">🚀</a>`;
            }

            return `<div class="env-row">
                <span class="env-icon">${icon}</span>
                ${actionLink}
                <span class="env-name">${envCfg.label}</span>
                <span class="env-status" style="color:${color}">${label}</span>
            </div>${newChangesNote}`;
        }).join("");

        const devPublished = progress[publishEnv.name] === "published";
        // "merged" (PR landed on the env branch) is deliberately NOT treated as done here —
        // only an actual `sf project deploy` (tracked as "deployed") completes a stage, so
        // promotion to the NEXT env can't get ahead of what's really live in this one.
        const nextEnv       = promotable.find(e => progress[e.name] !== "deployed");

        let actionButton = "";
        if (onFeatureBranch) {
            if (!devPublished) {
                actionButton =
                    `<button class="btn btn-primary" onclick="send('commitAndPush')">&#x2601; Commit &amp; Publish Feature Branch</button>`;
            } else if (nextEnv && progress[nextEnv.name] === "merged") {
                // PR already merged into nextEnv's branch — the real next step is deploying
                // it, not another promotion. Hand off straight to the Deployment Dashboard.
                actionButton =
                    `<div class="info">&#x26A1; ${nextEnv.label}'s PR is merged &mdash; deploy it to finish this stage.</div>
                     <button class="btn btn-primary" onclick="send('openDeploymentDashboard', '${nextEnv.name}')">&#x1F680; Deploy &mdash; ${nextEnv.label}</button>`;
            } else if (nextEnv) {
                const validateBtn =
                    `<button class="btn btn-primary" onclick="send('validate', '${nextEnv.name}')">&#x2714; Validate Only &mdash; ${nextEnv.label}</button>`;
                const coverageBlocked = coverageBlockedEnv === nextEnv.name;

                // The env the story is CURRENTLY sitting in — the one immediately before
                // nextEnv in the pipeline — is what needs sign-off before promoting onward.
                const nextIdx    = environments.findIndex(e => e.name === nextEnv.name);
                const currentEnv = nextIdx > 0 ? environments[nextIdx - 1] : undefined;
                const signoffBlocked = Boolean(currentEnv?.signoffGate && !signoffPassed[currentEnv.name]);
                const signoffAction = signoffBlocked
                    ? `<div class="warning">&#x26A0; ${currentEnv!.label} sign-off required before promoting to ${nextEnv.label}.</div>
                       <button class="btn btn-secondary" onclick="send('recordSignoff', '${currentEnv!.name}')">&#x2705; Record ${currentEnv!.label} Sign-off</button>`
                    : "";

                const promoteBtn = !canPromote(this._userRole, nextEnv)
                    ? `<div class="info">&#x2705; A "${nextEnv.requiredRole}" runs Promote to ${nextEnv.label} (opens a PR — deploying is a separate step after it's merged)</div>`
                    : (coverageBlocked || signoffBlocked)
                    ? `${coverageBlocked ? `<div class="warning">&#x26A0; Coverage check required before promoting to ${nextEnv.label} &mdash; <a href="#" onclick="send('focusCoverage')">run it here</a>.</div>` : ""}
                       ${signoffAction}
                       <button class="btn btn-primary" disabled title="Resolve the gate(s) above first">&#x1F680; Promote &mdash; ${nextEnv.label}</button>`
                    : `<button class="btn btn-primary" onclick="send('promote', '${nextEnv.name}')" title="Opens a PR into ${nextEnv.label} — deploying is a separate step once it's merged">&#x1F680; Promote &mdash; ${nextEnv.label}</button>`;
                actionButton = promoteBtn + validateBtn;
            } else {
                actionButton = `<div class="info">&#x2705; ${getTerminalStageMessage()}</div>`;
            }
        }

        const commitBtn = onFeatureBranch && devPublished
            ? `<button class="btn btn-secondary" onclick="send('commitAndPush')">&#x2601; Commit &amp; Publish more changes</button>`
            : "";

        const syncWarning = behindCount > 5
            ? `<div class="warning">&#x26A0; ${behindCount} commits behind ${baseBranch} &mdash; <a href="#" onclick="send('syncBranch')">sync now</a></div>`
            : "";

        const ticketUrl = buildTicketUrl(storyId);
        const storyIdHtml = storyId
            ? (ticketUrl
                ? `<a href="${ticketUrl}" style="color:inherit;text-decoration:none">${storyId}</a>`
                : storyId)
            : "";

        return `<!DOCTYPE html>
<html>
<head>
<style>
  body       { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); }
  .card      { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
  .branch    { font-size: 11px; color: var(--vscode-textPreformat-foreground); word-break: break-all; }
  .story-id  { font-size: 18px; font-weight: bold; margin: 4px 0; }
  .env-row   { display: flex; align-items: center; gap: 6px; padding: 3px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .env-icon  { width: 16px; }
  .env-name  { font-weight: 600; width: 48px; }
  .env-status{ font-size: 11px; }
  .env-note  { font-size: 10px; color: var(--vscode-descriptionForeground); margin: -2px 0 4px 22px; }
  .env-note a{ color: var(--vscode-textLink-foreground); }
  .btn       { display: block; width: 100%; padding: 7px; margin: 4px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-primary   { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .btn:disabled  { opacity: 0.5; cursor: default; }
  .warning   { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); color: var(--vscode-foreground); border-radius: 4px; padding: 6px 8px; font-size: 11px; margin-bottom: 6px; }
  .info      { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); color: var(--vscode-foreground); border-radius: 4px; padding: 6px 8px; font-size: 11px; margin: 4px 0; }
  .divider   { border-top: 1px solid var(--vscode-panel-border); margin: 8px 0; }
  a          { color: var(--vscode-textLink-foreground); }
  .no-story  { color: var(--vscode-descriptionForeground); font-size: 11px; }
  .toolbar   { display: flex; gap: 4px; margin-bottom: 8px; }
  .tbtn      { flex: 1; display: flex; align-items: center; justify-content: center; gap: 3px; padding: 4px 2px; font-size: 10.5px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; text-decoration: none; white-space: nowrap; overflow: hidden; }
  .tbtn:hover{ background: var(--vscode-button-secondaryHoverBackground); }
  .countdown { opacity: 0.65; font-size: 9.5px; }
  .version-footer { text-align: center; font-size: 10px; opacity: 0.5; margin-top: 10px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>

${syncWarning}

<div class="card">
  <div class="branch">${escapeHtml(branch)} ${branch !== "No branch" ? `<a href="#" onclick="send('viewBranchInBrowser')" title="View branch in browser">🔗</a>` : ""}</div>
  ${storyId ? `<div class="story-id">${storyIdHtml}</div>` : `<div class="no-story">No active story</div>`}
</div>

<div class="toolbar">
  <a class="tbtn" href="#" onclick="send('changeRole')" title="Change Role">👤 ${escapeHtml(this._userRole)}</a>
  <a class="tbtn" href="#" onclick="send('openDeploymentDashboard')" title="Deployment Dashboard">🚀 Deploy</a>
  <a class="tbtn" href="#" onclick="send('viewAuditLog')" title="Audit Trail">📋 Audit</a>
  <a class="tbtn" href="#" onclick="send('openSetupCheck')" title="Setup Check">⚙ Setup</a>
  <a class="tbtn" href="#" onclick="send('refresh')" title="Refresh"><span>↻ Refresh</span> <span id="countdown" class="countdown"></span></a>
</div>

<div class="card">
  <button class="btn btn-primary" onclick="send('startStory')">&#x1F680; Start New Story</button>
  <button class="btn btn-secondary" onclick="send('resumeStory')">&#x23F3; Continue with Existing Story</button>
</div>

${onFeatureBranch ? `
<div class="card">
  <b>Story Progress</b>
  <div class="divider"></div>
  ${envRows}
</div>

<div class="card">
  ${actionButton}
  ${commitBtn}
  <button class="btn btn-secondary" onclick="send('syncBranch')">&#x1F504; Sync with ${baseBranch}</button>
</div>
` : ""}

<div class="version-footer">v${escapeHtml(this._extContext.extension.packageJSON.version)}</div>

<script>
  const vscode = acquireVsCodeApi();
  function send(cmd, env) { vscode.postMessage({ command: cmd, env: env }); }

  (function () {
    let secondsLeft = ${AUTO_REFRESH_SECONDS};
    const el = document.getElementById('countdown');
    function tick() {
      if (!el) { return; }
      el.textContent = secondsLeft + 's';
      secondsLeft = Math.max(0, secondsLeft - 1);
    }
    tick();
    setInterval(tick, 1000);
  })();
</script>
</body>
</html>`;
    }

    /**
     * Gated view shown until every required setup check passes AND the user has clicked
     * "Confirm" once for this workspace. Nothing else in the panel renders until then.
     */
    private _getSetupGateHtml(checks: SetupCheckItem[], canConfirm: boolean, forced: boolean): string {
        const orgAliasSlots = getOrgAliasSlots();
        const connectedAliases = checks.find(c => c.key === "orgAuthentication")?.connectedAliases;

        const rows = checks.map(c => {
            const icon = c.passed ? "✅" : (c.required ? "❌" : "⚠️");
            const fixHtml = (!c.passed && c.fixSteps.length)
                ? `<ol class="fix">${c.fixSteps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
                : "";
            const orgAliasManager = c.key === "orgAuthentication"
                ? this._renderOrgAliasSlots(orgAliasSlots, canAccessConfig(this._userRole), connectedAliases)
                : "";
            return `<div class="check ${c.passed ? "pass" : (c.required ? "fail" : "warn")}">
  <div class="check-head"><span class="icon">${icon}</span><span class="label">${escapeHtml(c.label)}</span>${c.required ? "" : "<span class=\"opt\">optional</span>"}</div>
  <div class="detail">${escapeHtml(c.detail)}</div>
  ${fixHtml}
  ${orgAliasManager}
</div>`;
        }).join("");

        const requiredFailing = checks.filter(c => c.required && !c.passed).length;
        const statusBanner = requiredFailing > 0
            ? `<div class="warning">⚠ ${requiredFailing} required check(s) failing — fix them below, then re-check.</div>`
            : `<div class="info">✅ All required checks pass. Confirm below to start working.</div>`;

        return `<!DOCTYPE html>
<html>
<head>
<style>
  body     { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); }
  h2       { font-size: 13px; margin: 4px 0 10px; }
  .warning { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); color: var(--vscode-foreground); border-radius: 4px; padding: 6px 8px; font-size: 11px; margin-bottom: 10px; }
  .info    { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); color: var(--vscode-foreground); border-radius: 4px; padding: 6px 8px; font-size: 11px; margin-bottom: 10px; }
  .check   { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; }
  .check.fail { border-color: var(--vscode-inputValidation-errorBorder); }
  .check.warn { border-color: var(--vscode-inputValidation-warningBorder); }
  .check-head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  .opt     { font-size: 10px; font-weight: normal; color: var(--vscode-descriptionForeground); margin-left: 4px; }
  .detail  { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 3px 0 0 22px; word-break: break-all; }
  ol.fix   { margin: 6px 0 0 22px; padding-left: 16px; font-size: 11px; color: var(--vscode-editorWarning-foreground); }
  ol.fix li { padding: 1px 0; }
  .btn     { display: block; width: 100%; padding: 7px; margin: 10px 0 4px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-primary   { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .org-manager { margin: 6px 0 0 22px; }
  .org-row { display: flex; align-items: center; gap: 4px; margin: 3px 0; }
  .org-status { font-size: 11px; width: 14px; flex-shrink: 0; text-align: center; }
  .org-label { font-size: 11px; width: 32px; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
  .org-row input { flex: 1; font-size: 11px; padding: 3px 5px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
  .org-btn { font-size: 11px; padding: 3px 6px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  .org-readonly { flex: 1; font-size: 11px; color: var(--vscode-foreground); }
  .muted-note { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
</style>
</head>
<body>
<h2>⚙ Setup Check ${forced ? `<a href="#" style="float:right;font-size:11px;font-weight:normal" onclick="send('closeSetupCheck')">✕ Close</a>` : ""}</h2>
${statusBanner}
${rows}
${canConfirm ? `<button class="btn btn-primary" onclick="send('confirmSetup')">✅ Confirm Setup &amp; Continue</button>` : ""}
<button class="btn btn-secondary" onclick="send('recheckSetup')">🔄 Re-check Setup</button>
<script>
  const vscode = acquireVsCodeApi();
  function send(cmd, env) { vscode.postMessage({ command: cmd, env: env }); }
  function saveOrgAlias(key) {
    const el = document.getElementById('alias-' + key);
    vscode.postMessage({ command: 'saveOrgAlias', key: key, value: el ? el.value : '' });
  }
  function loginOrg(key) {
    const el = document.getElementById('alias-' + key);
    vscode.postMessage({ command: 'loginOrg', key: key, value: el ? el.value : '' });
  }
</script>
</body>
</html>`;
    }

    /**
     * Inline management rows for the 4 canonical org-alias slots (Dev/QA/UAT/Prod) —
     * view/edit/authenticate without hand-editing settings.json. Editing is Admin-only;
     * other roles see the same values read-only.
     */
    private _renderOrgAliasSlots(slots: OrgAliasSlot[], editable: boolean, connectedAliases?: Record<string, boolean>): string {
        const statusGlyph = (s: OrgAliasSlot): string => {
            if (!s.alias) { return `<span class="org-status" title="No alias set">—</span>`; }
            const connected = connectedAliases?.[s.key];
            return connected
                ? `<span class="org-status" title="Connected">✅</span>`
                : `<span class="org-status" title="Not authenticated — needs (re)login">❌</span>`;
        };

        if (!editable) {
            const rows = slots.map(s => `
  <div class="org-row">
    ${statusGlyph(s)}
    <span class="org-label">${escapeHtml(s.label)}</span>
    <span class="org-readonly">${escapeHtml(s.alias) || "(not set)"}</span>
  </div>`).join("");
            return `<div class="org-manager">${rows}<div class="muted-note">Ask an Admin to configure org aliases.</div></div>`;
        }

        const rows = slots.map(s => `
  <div class="org-row">
    ${statusGlyph(s)}
    <span class="org-label">${escapeHtml(s.label)}</span>
    <input type="text" id="alias-${s.key}" value="${escapeHtml(s.alias)}" placeholder="org alias / username">
    <button class="org-btn" title="Save" onclick="saveOrgAlias('${s.key}')">💾</button>
    <button class="org-btn" title="Authenticate if needed (opens a terminal only when not already connected)" onclick="loginOrg('${s.key}')">🔑</button>
  </div>`).join("");

        return `<div class="org-manager">${rows}</div>`;
    }

    private _getLoadingHtml(): string {
        return `<html><body style="font-family:var(--vscode-font-family);padding:16px">Loading...</body></html>`;
    }

    private _getErrorHtml(err: string): string {
        return `<html><body style="font-family:var(--vscode-font-family);padding:8px;color:var(--vscode-errorForeground)">Error: ${err}</body></html>`;
    }

    /** Rendered while a cherry-pick (dev-publish or promotion) is paused on conflicts. */
    private _getConflictHtml(
        pending:   PendingOp,
        conflicts: string[]
    ): string {
        const target = pending.kind === "dev-publish"
            ? "dev branch"
            : `${(pending.targetEnv ?? "").toUpperCase()} (${pending.mode === "validate" ? "validate" : "promote"})`;
        const unresolved = conflicts.length;
        const fileRows = conflicts.length
            ? conflicts.map(f => `<div class="file">⚠ ${f}</div>`).join("")
            : `<div class="ok">✓ No unresolved conflicts left — click Resume.</div>`;

        const status = unresolved
            ? `<div class="count">${unresolved} file(s) still have conflicts</div>`
            : `<div class="count ready">All conflicts resolved</div>`;

        return `<!DOCTYPE html>
<html>
<head>
<style>
  body     { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); }
  .card    { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px; margin-bottom: 8px; }
  .title   { font-weight: bold; font-size: 13px; margin-bottom: 4px; }
  .branch  { font-size: 11px; color: var(--vscode-textPreformat-foreground); word-break: break-all; margin-bottom: 6px; }
  .count   { font-size: 11px; color: var(--vscode-editorWarning-foreground); margin: 4px 0; }
  .count.ready { color: var(--vscode-charts-green); }
  .file    { font-size: 11px; color: var(--vscode-editorWarning-foreground); padding: 2px 0; word-break: break-all; }
  .ok      { font-size: 11px; color: var(--vscode-charts-green); padding: 2px 0; }
  .steps   { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 6px 0; }
  .btn     { display: block; width: 100%; padding: 7px; margin: 4px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-primary   { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>
<div class="card">
  <div class="title">⚙ Paused — resolve conflicts</div>
  <div class="branch">${pending.storyId} → ${target}</div>
  ${status}
  ${fileRows}
  <div class="steps">1. Resolve conflicts in the Source Control view &nbsp; 2. Save &nbsp; 3. Resume</div>
  <button class="btn btn-primary" onclick="send('resumePromotion')">▶ Resume</button>
  <button class="btn btn-secondary" onclick="send('cancelPromotion')">✕ Cancel</button>
  <div style="text-align:right; font-size:10px; color:var(--vscode-descriptionForeground); margin-top:4px">
    <a href="#" onclick="send('refresh')" style="color:var(--vscode-textLink-foreground)">↻ refresh</a>
  </div>
</div>
<script>
  const vscode = acquireVsCodeApi();
  function send(cmd) { vscode.postMessage({ command: cmd }); }
</script>
</body>
</html>`;
    }
}

