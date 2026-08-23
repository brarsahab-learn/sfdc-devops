// StoryWebviewProvider.ts
// Renders the main "Current Story" panel in the sidebar.
// Shows story progress across all environments + action buttons.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper, PendingOp } from "../GitHelper";
import {
    extractStoryId, isFeatureBranch, getBaseBranch, getEnvironments, getPublishEnvironment,
    getPromotableEnvironments, canPromote, getTerminalStageMessage, promoBranchName, buildTicketUrl,
} from "../config";
import { runSetupChecks, SetupCheckItem } from "../SetupCheck";

const SETUP_CONFIRMED_KEY = "sfDevops.setupConfirmed";

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

export class StoryWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "sfDevopsStoryView";
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _bbClient: IGitProviderClient,
        private readonly _gitHelper: GitHelper,
        private readonly _extContext: vscode.ExtensionContext,
        private readonly _userRole: string = "developer"
    ) {}

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
        webviewView.webview.onDidReceiveMessage(async (msg: { command: string; env?: string }) => {
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
                    vscode.commands.executeCommand("sfDevops.openDeploymentDashboard"); break;
                case "recheckSetup":
                    this.refresh(); break;
                case "confirmSetup":
                    await this._extContext.workspaceState.update(SETUP_CONFIRMED_KEY, true);
                    this.refresh();
                    break;
            }
        });

        this.refresh();
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
                this._view.webview.html = this._getSetupGateHtml(checks, false);
                return;
            }
            if (!confirmed) {
                this._view.webview.html = this._getSetupGateHtml(checks, true);
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
            const behind    = isFeatureBranch(branch)
                ? await this._gitHelper.commitsBehind(branch!, `origin/${getBaseBranch()}`)
                : 0;

            this._view.webview.html = this._getWebviewHtml(
                branch ?? "No branch", storyId, progress, behind
            );
        } catch (err) {
            this._view.webview.html = this._getErrorHtml(String(err));
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
     *   • every later environment — "merged" once the story is on the env's branch
     *     (PR merged / deployed), "open" once its promotion/validate branch exists,
     *     else "none".
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
            if (await this._gitHelper.branchContainsStory(envBranch, storyId)) { return "merged"; }

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

    private _getWebviewHtml(
        branch: string,
        storyId: string,
        progress: Record<string, string>,
        behindCount: number
    ): string {
        const onFeatureBranch = isFeatureBranch(branch);
        const baseBranch      = getBaseBranch();
        const environments    = getEnvironments();
        const publishEnv      = getPublishEnvironment();
        const promotable      = getPromotableEnvironments();

        const envRows = environments.map((envCfg) => {
            const state = progress[envCfg.name];
            let icon = "⏳", label = "Pending", color = "#888";
            if (state === "published")  { icon = "✅"; label = "Published";        color = "#36a64f"; }
            else if (state === "merged"){ icon = "✅"; label = "Deployed";         color = "#36a64f"; }
            else if (state === "open")  { icon = "🔄"; label = "Validated / In PR"; color = "#439fe0"; }
            return `<div class="env-row">
                <span class="env-icon">${icon}</span>
                <span class="env-name">${envCfg.label}</span>
                <span class="env-status" style="color:${color}">${label}</span>
            </div>`;
        }).join("");

        const devPublished = progress[publishEnv.name] === "published";
        const nextEnv       = promotable.find(e => progress[e.name] !== "merged");

        let actionButton = "";
        if (onFeatureBranch) {
            if (!devPublished) {
                actionButton =
                    `<button class="btn btn-primary" onclick="send('commitAndPush')">&#x2601; Commit &amp; Publish Feature Branch</button>`;
            } else if (nextEnv) {
                const validateBtn =
                    `<button class="btn btn-primary" onclick="send('validate', '${nextEnv.name}')">&#x2714; Validate Only &mdash; ${nextEnv.label}</button>`;
                const promoteBtn = !canPromote(this._userRole, nextEnv)
                    ? `<div class="info">&#x2705; A "${nextEnv.requiredRole}" runs Promote &amp; Deploy to ${nextEnv.label}</div>`
                    : `<button class="btn btn-primary" onclick="send('promote', '${nextEnv.name}')">&#x1F680; Promote &amp; Deploy &mdash; ${nextEnv.label}</button>`;
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
  .btn       { display: block; width: 100%; padding: 7px; margin: 4px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-primary   { background: #0078d4; color: white; }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn:disabled  { opacity: 0.5; cursor: default; }
  .warning   { background: #5a4a00; color: #ffd700; border-radius: 4px; padding: 6px 8px; font-size: 11px; margin-bottom: 6px; }
  .info      { background: #1e3a5f; color: #90caf9; border-radius: 4px; padding: 6px 8px; font-size: 11px; margin: 4px 0; }
  .divider   { border-top: 1px solid var(--vscode-panel-border); margin: 8px 0; }
  a          { color: #4fc3f7; }
</style>
</head>
<body>

${syncWarning}

<div class="card">
  <div class="branch">${branch}</div>
  ${storyId ? `<div class="story-id">${storyIdHtml}</div>` : "<div style='color:#888;font-size:11px'>No active story</div>"}
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

<div style="text-align:right; font-size:10px; color:#666; margin-top:4px">
  <a href="#" onclick="send('openDeploymentDashboard')">🚀 deployments</a> &nbsp;|&nbsp;
  <a href="#" onclick="send('viewAuditLog')">📋 audit trail</a> &nbsp;|&nbsp;
  <a href="#" onclick="send('refresh')">↻ refresh</a>
</div>

<script>
  const vscode = acquireVsCodeApi();
  function send(cmd, env) { vscode.postMessage({ command: cmd, env: env }); }
</script>
</body>
</html>`;
    }

    /**
     * Gated view shown until every required setup check passes AND the user has clicked
     * "Confirm" once for this workspace. Nothing else in the panel renders until then.
     */
    private _getSetupGateHtml(checks: SetupCheckItem[], canConfirm: boolean): string {
        const rows = checks.map(c => {
            const icon = c.passed ? "✅" : (c.required ? "❌" : "⚠️");
            const fixHtml = (!c.passed && c.fixSteps.length)
                ? `<ol class="fix">${c.fixSteps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
                : "";
            return `<div class="check ${c.passed ? "pass" : (c.required ? "fail" : "warn")}">
  <div class="check-head"><span class="icon">${icon}</span><span class="label">${escapeHtml(c.label)}</span>${c.required ? "" : "<span class=\"opt\">optional</span>"}</div>
  <div class="detail">${escapeHtml(c.detail)}</div>
  ${fixHtml}
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
  .warning { background: #5a4a00; color: #ffd700; border-radius: 4px; padding: 6px 8px; font-size: 11px; margin-bottom: 10px; }
  .info    { background: #1e3a5f; color: #90caf9; border-radius: 4px; padding: 6px 8px; font-size: 11px; margin-bottom: 10px; }
  .check   { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px 10px; margin-bottom: 6px; }
  .check.fail { border-color: #c62828; }
  .check.warn { border-color: #ffab70; }
  .check-head { display: flex; align-items: center; gap: 6px; font-weight: 600; }
  .opt     { font-size: 10px; font-weight: normal; color: #888; margin-left: 4px; }
  .detail  { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 3px 0 0 22px; word-break: break-all; }
  ol.fix   { margin: 6px 0 0 22px; padding-left: 16px; font-size: 11px; color: #ffab70; }
  ol.fix li { padding: 1px 0; }
  .btn     { display: block; width: 100%; padding: 7px; margin: 10px 0 4px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-primary   { background: #0078d4; color: white; }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
</style>
</head>
<body>
<h2>⚙ Setup Check</h2>
${statusBanner}
${rows}
${canConfirm ? `<button class="btn btn-primary" onclick="send('confirmSetup')">✅ Confirm Setup &amp; Continue</button>` : ""}
<button class="btn btn-secondary" onclick="send('recheckSetup')">🔄 Re-check Setup</button>
<script>
  const vscode = acquireVsCodeApi();
  function send(cmd, env) { vscode.postMessage({ command: cmd, env: env }); }
</script>
</body>
</html>`;
    }

    private _getLoadingHtml(): string {
        return `<html><body style="font-family:var(--vscode-font-family);padding:16px">Loading...</body></html>`;
    }

    private _getErrorHtml(err: string): string {
        return `<html><body style="font-family:var(--vscode-font-family);padding:8px;color:#f48771">Error: ${err}</body></html>`;
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
  .count   { font-size: 11px; color: #ffab70; margin: 4px 0; }
  .count.ready { color: #36a64f; }
  .file    { font-size: 11px; color: #ffab70; padding: 2px 0; word-break: break-all; }
  .ok      { font-size: 11px; color: #36a64f; padding: 2px 0; }
  .steps   { font-size: 11px; color: #aaa; margin: 6px 0; }
  .btn     { display: block; width: 100%; padding: 7px; margin: 4px 0; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-primary   { background: #0078d4; color: white; }
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
  <div style="text-align:right; font-size:10px; color:#666; margin-top:4px">
    <a href="#" onclick="send('refresh')" style="color:#4fc3f7">↻ refresh</a>
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

