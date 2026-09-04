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
    ResolvedEnvironment, getFallbackRefreshSeconds, featureBranchName,
} from "../config";
import { runSetupChecks, SetupCheckItem } from "../SetupCheck";
import { getEffectiveRole, canAccessConfig } from "../RoleManager";
import { isOrgConnected, execSf } from "../SfCli";
import { getStoryProgress, getStoryTimelines, EnvTimeline } from "../StoryProgress";

const SETUP_CONFIRMED_KEY = "sfDevops.setupConfirmed";

/** The stage a story is about to move through next, and which org that actually means — enough for a status bar item to show "which org am I about to touch" without re-deriving the environment itself. */
export interface CurrentStageInfo {
    label:     string;
    orgAlias?: string;
    isProd:    boolean;
}

export interface StoryStatusInfo {
    branch:   string;
    storyId:  string;
    stage:    CurrentStageInfo | null;
}

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

// Shared busy-state bar for all three panel templates (main, setup gate, conflict) — a click
// used to have no visible effect until the next full webview.html swap landed, which could
// look frozen or unresponsive for a moment. A full refresh always replaces this markup
// wholesale, so "clear the busy state" needs no explicit signal — it's implicit in a new
// render arriving.
//
// The fallback timeout only exists for the case where NOTHING ever re-renders at all (e.g. a
// QuickPick the user cancelled) — it must never be short enough to fire while a real command
// is still genuinely running. This bit a real user: Resume/Promote/Validate can involve a
// git push plus an actual Salesforce check-only deploy, which routinely takes well past a
// few seconds — a too-short timeout re-enabled the button while that was still in flight,
// which both looked like nothing happened AND invited a second click that started a SECOND
// overlapping git/CLI operation in the same working tree, compounding the apparent hang.
// 2 minutes is short enough to still recover a truly-stuck panel, but long enough that it
// essentially never races a real in-flight operation (the QuickPick-cancel case it actually
// exists for resolves near-instantly regardless).
const BUSY_TIMEOUT_MS = 120_000;
const BUSY_BAR_CSS = `
  .busy-bar { display: none; position: sticky; top: 0; z-index: 20; background: var(--vscode-statusBarItem-warningBackground, var(--vscode-badge-background)); color: var(--vscode-statusBarItem-warningForeground, var(--vscode-badge-foreground)); font-size: 11px; text-align: center; padding: 3px 0; margin: -8px -8px 8px; }
  body.busy .btn, body.busy .tbtn, body.busy button, body.busy .org-btn { pointer-events: none; opacity: 0.55; }
`;
const BUSY_BAR_HTML = `<div class="busy-bar" id="busyBar">&#x23F3; Working&hellip; (this can take a while for a real validate/deploy)</div>`;
const BUSY_BAR_JS = `
  function showBusy() {
    document.body.classList.add('busy');
    var bar = document.getElementById('busyBar');
    if (bar) { bar.style.display = 'block'; }
    clearTimeout(window.__busyTimeout);
    window.__busyTimeout = setTimeout(function () {
      document.body.classList.remove('busy');
      if (bar) { bar.style.display = 'none'; }
    }, ${BUSY_TIMEOUT_MS});
  }
`;

export class StoryWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = "sfDevopsStoryView";
    private _view?: vscode.WebviewView;
    private _forceShowSetup = false;
    private _autoRefreshTimer?: NodeJS.Timeout;
    /** The branch this panel last rendered — compared on every refresh() to notice a branch change that DIDN'T come from one of this panel's own actions (Source Control, terminal, another tool). Undefined until the first refresh, so no notice fires on startup. */
    private _lastKnownBranch?: string;
    /** One-shot, same idiom as DeploymentDashboardPanel's _lastOutcome — shown once, then cleared. */
    private _externalSwitchNotice?: string;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _bbClient: IGitProviderClient,
        private readonly _gitHelper: GitHelper,
        private readonly _extContext: vscode.ExtensionContext,
        /** Fed the same branch/story/stage refresh() already derives, so the status bar item never has to recompute (and risk drifting from) what the sidebar itself is showing. `null` covers "nothing to show right now" states (no view resolved yet, setup gate, paused conflict). */
        private readonly _onStatusChange?: (info: StoryStatusInfo | null) => void
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
        webviewView.webview.onDidReceiveMessage(async (msg: { command: string; env?: string; key?: string; value?: string; path?: string }) => {
            switch (msg.command) {
                case "resumeStory":
                    vscode.commands.executeCommand("sfDevops.resumeStory"); break;
                case "startStory":
                    vscode.commands.executeCommand("sfDevops.startStory"); break;
                case "commitAndPush":
                    vscode.commands.executeCommand("sfDevops.commitAndPush"); break;
                case "promote":
                    // No msg.env (e.g. the toolbar's general "Promote" button, not the
                    // per-story action button) → the command itself prompts for which
                    // environment, then opens the picker of eligible stories for it —
                    // independent of whatever story/branch is currently checked out.
                    vscode.commands.executeCommand("sfDevops.promoteEnv", msg.env || undefined);
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
                case "viewWorkingFileDiff":
                    if (msg.path) { await this._viewWorkingFileDiff(msg.path); }
                    break;
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
                case "openOrg":
                    if (msg.value?.trim()) { await this._openOrgInBrowser(msg.value.trim()); }
                    break;
                case "recordSignoff":
                    if (msg.env) { await this._recordSignoff(msg.env); }
                    break;
                case "acknowledgeDeletion":
                    if (msg.env) { await this._recordDeletionAck(msg.env); }
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
            this._autoRefreshTimer = setTimeout(() => this.refresh(), getFallbackRefreshSeconds() * 1000);
        }
    }

    /** `sf org open` launches the org straight in the default browser itself — no need to parse a URL out of its JSON, just run it and surface a friendly error if the alias isn't actually authenticated. */
    private async _openOrgInBrowser(alias: string): Promise<void> {
        try {
            await execSf(["org", "open", "--target-org", alias], {
                cwd: this._gitHelper.getWorkspaceRoot(), timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(
                `Could not open "${alias}" — it may not be authenticated yet. Use 🔑 to log in first. (${err?.message ?? err})`
            );
        }
    }

    /** Opens VS Code's own diff editor for a working-tree file against HEAD — reuses the built-in diff view instead of the Dashboard's custom renderer, since this is a quick "what did I actually change" look, not a file-selection UI. */
    private async _viewWorkingFileDiff(relPath: string): Promise<void> {
        const root = this._gitHelper.getWorkspaceRoot();
        const fileUri = vscode.Uri.file(`${root}/${relPath}`);
        const headUri = fileUri.with({ scheme: "git", query: JSON.stringify({ path: fileUri.fsPath, ref: "HEAD" }) });
        await vscode.commands.executeCommand("vscode.diff", headUri, fileUri, `${relPath} (Working Tree)`);
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

    /**
     * Compares the branch this refresh() call is about to render against the one the LAST
     * refresh() rendered — if they differ, and the difference wasn't caused by one of this
     * extension's own checkouts (GitHelper.isRecentSelfInitiatedSwitch), sets a one-shot
     * notice so the panel visibly acknowledges "something changed outside your clicks" instead
     * of just silently redrawing as if nothing happened. Runs on every refresh() regardless of
     * what triggered it (live GitWatcher event, the fallback timer, or a manual click) — that's
     * fine, self-initiated switches from our own commands land here too and are filtered out
     * the same way.
     */
    private _noteBranchForExternalSwitchDetection(branch: string | null): void {
        const previous = this._lastKnownBranch;
        this._lastKnownBranch = branch ?? undefined;
        if (!branch || !previous || previous === branch) { return; }
        if (this._gitHelper.isRecentSelfInitiatedSwitch()) { return; }
        const storyId = extractStoryId(branch);
        this._externalSwitchNotice = `🔀 Switched to ${storyId || branch} — branch changed outside the extension.`;
    }

    public async refresh() {
        if (!this._view) { return; }

        // Set from whichever branch below actually runs, then reported once in `finally` —
        // one call site regardless of which early return fires, so the status bar item can
        // never end up out of sync with what the sidebar itself just decided to show.
        let statusInfo: StoryStatusInfo | null = null;

        try {
            // Basic setup must be validated (and, the first time, explicitly confirmed)
            // before anything else in this panel is shown.
            const checks = await runSetupChecks(this._gitHelper, this._bbClient, this._extContext, this._userRole);
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
            this._noteBranchForExternalSwitchDetection(branch);
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
            const timelines = storyId ? await getStoryTimelines(this._gitHelper, storyId) : {};
            const deletionAckPending = (onFeature && storyId) ? await this._getDeletionAckPending(storyId) : null;

            this._view.webview.html = this._getWebviewHtml(
                branch ?? "No branch", storyId, progress, behind, coverageBlockedEnv, repoOverride, signoffPassed, localChanges, timelines, deletionAckPending
            );
            this._externalSwitchNotice = undefined; // one-shot: shown once, then cleared

            if (branch && storyId) {
                statusInfo = { branch, storyId, stage: this._deriveCurrentStage(progress) };
            }
        } catch (err) {
            this._view.webview.html = this._getErrorHtml(String(err));
        } finally {
            this._scheduleAutoRefresh();
            this._onStatusChange?.(statusInfo);
        }
    }

    /**
     * Same "which stage is next" rule `_getWebviewHtml` uses for its pipeline's current-step
     * highlight (dev while unpublished, otherwise the first promotable env not yet actually
     * deployed) — duplicated here in miniature rather than threaded out of that method, since
     * this only needs a small summary, not the full render. Null once every stage is deployed
     * (terminal/complete state). Carries orgAlias/isProd too so the status bar item's "which
     * org am I about to touch" cue never has to re-derive the environment on its own.
     */
    private _deriveCurrentStage(progress: Record<string, string>): CurrentStageInfo | null {
        const publishEnv = getPublishEnvironment();
        if (progress[publishEnv.name] !== "published") {
            return { label: publishEnv.label, orgAlias: publishEnv.orgAlias, isProd: publishEnv.isProd };
        }
        const nextEnv = getPromotableEnvironments().find(e => progress[e.name] !== "deployed");
        if (!nextEnv) { return null; }
        return { label: nextEnv.label, orgAlias: nextEnv.orgAlias, isProd: nextEnv.isProd };
    }

    private async _getStoryProgress(storyId: string): Promise<Record<string, string>> {
        return getStoryProgress(this._gitHelper, this._bbClient, storyId);
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
     * Returns info about the first promotable env blocked by unacknowledged deleted files,
     * or null if no block exists.
     */
    private async _getDeletionAckPending(storyId: string): Promise<{ env: string; envLabel: string; files: string[] } | null> {
        if (!storyId) { return null; }
        let preview: { path: string; change: "added" | "modified" | "deleted" }[];
        try {
            preview = await this._gitHelper.previewStoryFiles(storyId);
        } catch {
            return null;
        }
        const deleted = preview.filter(f => f.change === "deleted");
        if (deleted.length === 0) { return null; }

        const featureSha = await this._gitHelper.remoteHeadSha(featureBranchName(storyId));
        if (!featureSha) { return null; }

        for (const env of getPromotableEnvironments()) {
            const ack = await this._gitHelper.getDeletionAcknowledgement(storyId, env.name);
            if (!ack || ack.sha !== featureSha) {
                return { env: env.name, envLabel: env.label, files: deleted.map(f => f.path) };
            }
        }
        return null;
    }

    private async _recordDeletionAck(envName: string): Promise<void> {
        const branch  = await this._gitHelper.currentBranch();
        const storyId = extractStoryId(branch);
        if (!storyId) { return; }
        const featureSha = await this._gitHelper.remoteHeadSha(featureBranchName(storyId));
        if (!featureSha) {
            vscode.window.showWarningMessage("Could not determine the current feature branch SHA — push your branch first.");
            return;
        }
        const env = getEnvironments().find(e => e.name === envName);
        await this._gitHelper.setDeletionAcknowledgement(storyId, envName, featureSha);
        await this._gitHelper.appendAudit({
            operation: "acknowledgeDeletion",
            storyId,
            targetEnv: envName,
            outcome: "success",
            summary: `Deletion manually acknowledged for ${env?.label ?? envName} at SHA ${featureSha.slice(0, 8)}`,
        });
        vscode.window.showInformationMessage(`✅ Deletion acknowledged for ${env?.label ?? envName}. Promote/Validate is now unblocked.`);
        this.refresh();
    }

    /**
     * Local working-tree changes not yet published to dev — surfaced so "DEV: Published"
     * doesn't silently go stale the moment you make another edit. `other` covers anything
     * uncommitted that isn't staged (unstaged edits, new untracked files); it's auto-preserved
     * via stash (not lost or silently swept in) if "Commit to Dev" is used while it's present.
     */
    private async _getLocalChangesSummary(): Promise<{ staged: string[]; other: string[] } | null> {
        const stagedList = await this._gitHelper.stagedFiles();
        const allChanged = await this._gitHelper.workingTreeFiles();
        const stagedSet  = new Set(stagedList);
        const other = allChanged.filter(f => !stagedSet.has(f));
        return (stagedList.length === 0 && other.length === 0) ? null : { staged: stagedList, other };
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

    // Per-stage guidance for the ℹ️ tooltip in the Story Progress pipeline — explains how
    // that stage's mechanics work and what the next concrete action is, given its current
    // state. Kept as plain text (goes into an HTML `title` attribute, not markup).
    private _stageInfoText(envCfg: ResolvedEnvironment, state: string | undefined, isPublishStage: boolean): string {
        if (isPublishStage) {
            switch (state) {
                case "published":
                    return `Published directly to ${envCfg.label} via Commit & Publish — no PR, no review. Next: promote it to the following stage.`;
                default:
                    return `The first stage — click "Commit & Publish" to push your changes straight to ${envCfg.label} (no PR, no review gate).`;
            }
        }
        const roleNote = envCfg.requiredRole ? ` (requires the "${envCfg.requiredRole}" role to promote)` : "";
        switch (state) {
            case "branch-created":
                return `Promotion branch created, but validation hasn't passed yet — a PR can't open until it does. Click ✔ Validate or 🚀 Promote (which validates for you) to run a real check-only deploy against ${envCfg.label}.`;
            case "open":
                return `Validated, and a promotion PR into ${envCfg.label} is open (or ready to be). Get it reviewed and merged — nothing deploys automatically when it merges.`;
            case "merged":
                return `The PR merged, but that alone doesn't deploy anything. Click 🚀 to run a real deploy against the ${envCfg.label} org.`;
            case "deployed":
                return `Deployed to ${envCfg.label}. This stage is complete for this story.`;
            default:
                return `Not started for this story. Click ⬆ to pick a story and promote it to ${envCfg.label} — this opens a PR${roleNote}; merging it is the review gate, deploying is a separate step after that.`;
        }
    }

    /**
     * Per-stage active/inactive badges (🟢 done vs ⚪ pending) plus an expandable accordion
     * with the real timestamp behind each one — "what actually happened here, and when,"
     * distinct from the single current/pending pipeline state above (which only ever shows
     * ONE state per row). Dev/publish only has Publish+Deploy; every other stage has
     * Validate+Promote+Deploy, matching the mandatory-validation sequence in promoteStory.ts.
     */
    private _renderStageTimeline(timeline: EnvTimeline | undefined, isPublishStage: boolean): { badges: string; accordion: string } {
        const stages: { label: string; entry?: { done: boolean; at?: string } }[] = isPublishStage
            ? [
                { label: "Published", entry: timeline?.published },
                { label: "Deployed",  entry: timeline?.deployment },
              ]
            : [
                { label: "Validated", entry: timeline?.validation },
                { label: "Promoted (PR opened)", entry: timeline?.promotion },
                { label: "Deployed",  entry: timeline?.deployment },
              ];

        const when = (entry?: { done: boolean; at?: string }): string => {
            if (!entry?.done) { return "Pending"; }
            if (!entry.at) { return "Done"; }
            const d = new Date(entry.at);
            return isNaN(d.getTime()) ? "Done" : d.toLocaleString();
        };

        const badges = stages.map(s => {
            const done = Boolean(s.entry?.done);
            return `<span class="stage-badge ${done ? "done" : "pending"}" title="${escapeHtml(s.label)}: ${escapeHtml(when(s.entry))}">${done ? "🟢" : "⚪"}</span>`;
        }).join("");

        const rows = stages.map(s => {
            const done = Boolean(s.entry?.done);
            return `<li><span class="stage-name">${done ? "🟢" : "⚪"} ${escapeHtml(s.label)}</span><span class="stage-when ${done ? "done" : "pending"}">${escapeHtml(when(s.entry))}</span></li>`;
        }).join("");
        const accordion = `<details class="stage-timeline"><summary>Timeline</summary><ul>${rows}</ul></details>`;

        return { badges, accordion };
    }

    private _getWebviewHtml(
        branch: string,
        storyId: string,
        progress: Record<string, string>,
        behindCount: number,
        coverageBlockedEnv: string | null,
        repoOverride: { workspace: string; repoSlug: string } | undefined,
        signoffPassed: Record<string, boolean>,
        localChanges: { staged: string[]; other: string[] } | null,
        timelines: Record<string, EnvTimeline>,
        deletionAckPending: { env: string; envLabel: string; files: string[] } | null = null
    ): string {
        const onFeatureBranch = isFeatureBranch(branch);
        const baseBranch      = getBaseBranch();
        const environments    = getEnvironments();
        const publishEnv      = getPublishEnvironment();
        const promotable      = getPromotableEnvironments();

        const devPublished = progress[publishEnv.name] === "published";
        // "merged" (PR landed on the env branch) is deliberately NOT treated as done here —
        // only an actual `sf project deploy` (tracked as "deployed") completes a stage, so
        // promotion to the NEXT env can't get ahead of what's really live in this one.
        const nextEnv       = promotable.find(e => progress[e.name] !== "deployed");
        // Which single stage the pipeline view highlights as "you are here" — dev itself
        // while it's still unpublished, otherwise whichever stage isn't deployed yet.
        const currentEnvName = !devPublished ? publishEnv.name : (nextEnv?.name ?? null);

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
                // Validation is mandatory and gates the PR — so which button is "primary"
                // (the actually-next step) depends on whether nextEnv's promotion branch has
                // ALREADY passed it. Not yet validated ("none"/"branch-created"): Validate is
                // next, Promote is just secondary (it still works — it validates first — but
                // shouldn't look equally "ready" as Validate). Already validated ("open"):
                // Promote (open the PR) is next, Validate becomes a secondary "re-validate."
                const isValidated = progress[nextEnv.name] === "open";
                const validateBtn =
                    `<button class="btn ${isValidated ? "btn-secondary" : "btn-primary"}" onclick="send('validate', '${nextEnv.name}')">&#x2714; ${isValidated ? "Re-validate" : "Validate Only"} &mdash; ${nextEnv.label}</button>`;
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

                const promoteClass = isValidated ? "btn-primary" : "btn-secondary";
                const promoteBtn = !canPromote(this._userRole, nextEnv)
                    ? `<div class="info">&#x2705; A "${nextEnv.requiredRole}" runs Promote to ${nextEnv.label} (opens a PR — deploying is a separate step after it's merged)</div>`
                    : (coverageBlocked || signoffBlocked)
                    ? `${coverageBlocked ? `<div class="warning">&#x26A0; Coverage check required before promoting to ${nextEnv.label} &mdash; <a href="#" onclick="send('focusCoverage')">run it here</a>.</div>` : ""}
                       ${signoffAction}
                       <button class="btn btn-primary" disabled title="Resolve the gate(s) above first">&#x1F680; Promote &mdash; ${nextEnv.label}</button>`
                    : `<button class="btn ${promoteClass}" onclick="send('promote', '${nextEnv.name}')" title="${isValidated ? `Opens a PR into ${nextEnv.label} — deploying is a separate step once it's merged` : `Validates first, then opens a PR into ${nextEnv.label} once it passes`}">&#x1F680; Promote &mdash; ${nextEnv.label}</button>`;
                actionButton = isValidated ? (promoteBtn + validateBtn) : (validateBtn + promoteBtn);
            } else {
                actionButton = `<div class="info">&#x2705; ${getTerminalStageMessage()}</div>`;
            }
        }

        // Vertical pipeline: every stage connected in one glance — done stages filled green,
        // the CURRENT stage highlighted with its action attached directly to it (not a
        // separate floating card you have to match up yourself), everything after it
        // visibly still ahead. Replaces the old flat list of rows + a disconnected button.
        //
        // Only ONE stage is ever actionable at a time — currentIdx is that stage's position.
        // A later stage can still carry real git history (e.g. a promotion PR merged into it
        // before this hard gate existed, or before an earlier stage's deploy), but showing
        // that raw state with live ⬆/🚀 buttons attached would look like two stages are
        // simultaneously "ready to go" when the server would actually reject acting on the
        // later one — see GitHelper.checkPrevEnvDeployed. Every stage after currentIdx is
        // rendered as locked/waiting instead, regardless of its own underlying state.
        const currentIdx = currentEnvName ? environments.findIndex(e => e.name === currentEnvName) : -1;

        const envRows = environments.map((envCfg, idx) => {
            const state = progress[envCfg.name];
            const isCurrent = envCfg.name === currentEnvName;
            const isDone = !isCurrent && (state === "published" || state === "deployed");
            const isFuture = currentIdx !== -1 && idx > currentIdx;
            const stepClass = isCurrent ? "current" : isFuture ? "future" : isDone ? "done" : "pending";
            const isPublishStage = envCfg.name === publishEnv.name;

            let icon = "○", label = "Pending";
            let infoText: string;
            let stageLinks = "";
            let newChangesNote = "";

            if (isFuture) {
                // Deliberately ignores the row's own raw state (progress[envCfg.name]) — see
                // the comment above envRows. currentIdx is always valid here (>= 0) since
                // isFuture only true when currentIdx !== -1.
                icon = "🔒";
                label = `Waiting for ${environments[currentIdx].label}`;
                infoText = `${envCfg.label} can't be promoted or deployed until ${environments[currentIdx].label} is actually deployed — one stage at a time keeps the pipeline linear.`;
            } else {
                if (state === "published")  { icon = "✅"; label = "Published"; }
                else if (state === "deployed") { icon = "✅"; label = "Deployed"; }
                else if (state === "merged")   { icon = "⚡"; label = "Merged — ready to deploy"; }
                else if (state === "open")  { icon = "🔄"; label = "Validated / In PR"; }
                else if (state === "branch-created") { icon = "🧪"; label = "Branch created — validation required"; }
                if (isDone) { icon = "✓"; }

                // DEV already shows "Published", but there's more local work since then —
                // flag it explicitly instead of letting the badge quietly go stale. The count
                // alone used to be the whole story; now it expands to the actual file paths
                // so you don't have to leave the panel to see what's about to be published.
                if (isPublishStage && state === "published" && localChanges) {
                    icon = isCurrent ? icon : "⚠️";
                    const total = localChanges.staged.length + localChanges.other.length;
                    label = `Published — ${total} new change(s) pending`;
                    const parts: string[] = [];
                    if (localChanges.staged.length > 0) { parts.push(`${localChanges.staged.length} staged`); }
                    if (localChanges.other.length > 0)  { parts.push(`${localChanges.other.length} in progress (preserved automatically)`); }
                    const fileRow = (f: string, badge: string) =>
                        `<li><span class="file-path" onclick="viewWorkingDiff('${escapeHtml(f)}')" title="View diff">${escapeHtml(f)}</span><span class="story-badge">${badge}</span></li>`;
                    const fileList = [
                        ...localChanges.staged.map(f => fileRow(f, "staged")),
                        ...localChanges.other.map(f => fileRow(f, "unstaged")),
                    ].join("");
                    newChangesNote = `<div class="env-note">${parts.join(", ")} — <a href="#" onclick="send('commitAndPush')">commit to dev</a>
                      <details class="changed-files"><summary>Show files</summary><ul class="files">${fileList}</ul></details>
                    </div>`;
                }

                // Promote/Deploy are available directly per stage, not just as generic toolbar
                // buttons — pick a story for THIS stage's picker, or jump to THIS stage's tab
                // in the Dashboard, without needing your current story to be at that exact
                // point. Dev has no promotion step, but IS independently deployable (to the
                // Dev org itself) once something's published — that used to have no visible
                // trigger at all, which is exactly what made it unclear whether dev had ever
                // really been deployed vs. just pushed to the branch.
                if (isPublishStage) {
                    if (state === "published") {
                        stageLinks += ` <a href="#" title="Open Dev in the Deployment Dashboard to deploy it to the Dev org" onclick="send('openDeploymentDashboard', '${envCfg.name}')">🚀</a>`;
                    }
                } else {
                    stageLinks += ` <a href="#" title="Promote a story to ${envCfg.label} (pick from a list — opens a PR)" onclick="send('promote', '${envCfg.name}')">⬆</a>`;
                    stageLinks += ` <a href="#" title="Open ${envCfg.label} in the Deployment Dashboard" onclick="send('openDeploymentDashboard', '${envCfg.name}')">🚀</a>`;
                }
                if (state === "open" && storyId) {
                    const promotionBranch = promoBranchName(storyId, envCfg.name, "promote");
                    const prUrl = this._bbClient.buildPrUrl(promotionBranch, envCfg.branch, repoOverride);
                    if (prUrl) { stageLinks += ` <a href="${prUrl}" title="Open this story's PR in browser to review it">🔗</a>`; }
                }

                infoText = this._stageInfoText(envCfg, state, isPublishStage);
            }

            const infoIcon = ` <a href="#" class="pinfo" title="${escapeHtml(infoText)}" onclick="return false;">ℹ️</a>`;
            const cta = isCurrent && actionButton ? `<div class="pcta">${actionButton}</div>` : "";
            const isLast = idx === environments.length - 1;
            const { badges: stageBadges, accordion: stageAccordion } = this._renderStageTimeline(timelines[envCfg.name], isPublishStage);

            return `<div class="pstep ${stepClass}">
              <div class="pdot-col"><div class="pdot">${icon}</div>${isLast ? "" : `<div class="pline"></div>`}</div>
              <div class="pbody">
                <div class="pname">${envCfg.label}<span class="pstatus">${label}</span>${infoIcon}${stageLinks}</div>
                <div class="stage-badges">${stageBadges}</div>
                ${newChangesNote}
                ${cta}
                ${stageAccordion}
              </div>
            </div>`;
        }).join("");

        const moreActions = onFeatureBranch
            ? `<div class="more-actions">
                 ${devPublished ? `<a href="#" onclick="send('commitAndPush')">☁ Publish more changes</a> · ` : ""}
                 <a href="#" onclick="send('syncBranch')">🔄 Sync with ${baseBranch}</a>
               </div>`
            : "";

        const syncWarning = behindCount > 5
            ? `<div class="warning">&#x26A0; ${behindCount} commits behind ${baseBranch} &mdash; <a href="#" onclick="send('syncBranch')">sync now</a></div>`
            : "";

        // One-shot acknowledgment that something changed HEAD outside this panel's own
        // buttons (Source Control, terminal, another tool) — see
        // _noteBranchForExternalSwitchDetection. Read directly off instance state (same
        // pattern DeploymentDashboardPanel uses for _lastOutcome) rather than threaded through
        // as a parameter, since it's cleared by refresh() right after this render.
        const externalSwitchNotice = this._externalSwitchNotice
            ? `<div class="info">${escapeHtml(this._externalSwitchNotice)}</div>`
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
  .pipeline  { margin: 2px 0 0; }
  .pstep     { display: flex; gap: 8px; }
  .pdot-col  { display: flex; flex-direction: column; align-items: center; width: 18px; flex-shrink: 0; }
  .pdot      { width: 16px; height: 16px; min-height: 16px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 9px; line-height: 1; border: 2px solid var(--vscode-panel-border); background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); flex-shrink: 0; box-sizing: border-box; }
  .pstep.done .pdot    { background: var(--vscode-charts-green); border-color: var(--vscode-charts-green); color: var(--vscode-editor-background); }
  .pstep.current .pdot { border-color: var(--vscode-charts-blue); box-shadow: 0 0 0 2px var(--vscode-charts-blue); background: var(--vscode-editor-background); }
  .pline     { width: 2px; flex: 1; min-height: 8px; background: var(--vscode-panel-border); margin: 2px 0; }
  .pstep.done .pline { background: var(--vscode-charts-green); }
  .pbody     { flex: 1; min-width: 0; padding-bottom: 12px; }
  .pname     { font-weight: 600; font-size: 12px; }
  .pstatus   { font-size: 11px; font-weight: normal; color: var(--vscode-descriptionForeground); margin-left: 6px; }
  .pstep.current .pstatus { color: var(--vscode-charts-blue); }
  .pstep.current .pname   { color: var(--vscode-charts-blue); }
  .pstep.future  { opacity: 0.55; }
  .pcta      { margin-top: 6px; }
  .pcta .btn { margin: 3px 0; }
  .pname a   { text-decoration: none; margin-left: 4px; font-size: 11px; }
  .pname a.pinfo { cursor: help; }
  .env-note  { font-size: 10px; color: var(--vscode-descriptionForeground); margin: 2px 0 0; }
  .env-note a{ color: var(--vscode-textLink-foreground); }
  .changed-files { margin-top: 2px; }
  .changed-files summary { cursor: pointer; font-size: 10px; color: var(--vscode-textLink-foreground); }
  .changed-files ul.files { list-style: none; margin: 3px 0 0; padding: 0; font-size: 10px; }
  .changed-files ul.files li { display: flex; align-items: center; gap: 5px; padding: 1px 0; }
  .changed-files .file-path { cursor: pointer; word-break: break-all; color: var(--vscode-foreground); }
  .changed-files .file-path:hover { color: var(--vscode-textLink-foreground); text-decoration: underline; }
  .changed-files .story-badge { font-size: 9px; color: var(--vscode-descriptionForeground); border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 0 4px; flex-shrink: 0; }
  .stage-badges { display: flex; gap: 3px; margin: 2px 0; }
  .stage-badge  { font-size: 9px; cursor: default; opacity: 0.55; }
  .stage-badge.done { opacity: 1; }
  .stage-timeline { margin-top: 2px; }
  .stage-timeline summary { cursor: pointer; font-size: 10px; color: var(--vscode-textLink-foreground); }
  .stage-timeline ul { list-style: none; margin: 3px 0 0; padding: 0; font-size: 10px; }
  .stage-timeline li { display: flex; justify-content: space-between; gap: 8px; padding: 1px 0; }
  .stage-timeline .stage-name { color: var(--vscode-foreground); }
  .stage-timeline .stage-when { color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .stage-timeline .stage-when.done { color: var(--vscode-charts-green); }
  .more-actions { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--vscode-panel-border); }
  .more-actions a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  .more-actions a:hover { text-decoration: underline; }
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
  ${BUSY_BAR_CSS}
</style>
</head>
<body>
${BUSY_BAR_HTML}

${externalSwitchNotice}
${syncWarning}
${deletionAckPending ? `<div class="warning">
  ⚠ ${escapeHtml(storyId)} deletes ${deletionAckPending.files.length} component(s) not yet manually removed from ${escapeHtml(deletionAckPending.envLabel)}.
  <br>Remove them from the org, then: <a href="#" onclick="send('acknowledgeDeletion', '${deletionAckPending.env}')">✅ Acknowledge manual deletion for ${escapeHtml(deletionAckPending.envLabel)}</a>
</div>` : ""}

<div class="card">
  <div class="branch">${escapeHtml(branch)} ${branch !== "No branch" ? `<a href="#" onclick="send('viewBranchInBrowser')" title="View branch in browser">🔗</a>` : ""}</div>
  ${storyId ? `<div class="story-id">${storyIdHtml}</div>` : `<div class="no-story">No active story</div>`}
</div>

<div class="toolbar">
  <a class="tbtn" href="#" onclick="send('changeRole')" title="Change Role">👤 ${escapeHtml(this._userRole)}</a>
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
  <div class="pipeline">${envRows}</div>
  ${moreActions}
</div>
` : ""}

<div class="version-footer">v${escapeHtml(this._extContext.extension.packageJSON.version)}</div>

<script>
  const vscode = acquireVsCodeApi();
  ${BUSY_BAR_JS}
  function send(cmd, env) { showBusy(); vscode.postMessage({ command: cmd, env: env }); }
  function viewWorkingDiff(path) { vscode.postMessage({ command: 'viewWorkingFileDiff', path: path }); }

  (function () {
    let secondsLeft = ${getFallbackRefreshSeconds()};
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
  body     { font-family: var(--vscode-font-family); font-size: 12px; padding: 8px; color: var(--vscode-foreground); padding-bottom: 4px; }
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
  .action-bar { position: sticky; bottom: -8px; margin: 12px -8px -8px; padding: 8px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-top: 1px solid var(--vscode-panel-border); }
  .action-bar .btn { margin: 4px 0; }
  ${BUSY_BAR_CSS}
</style>
</head>
<body>
${BUSY_BAR_HTML}
<h2>⚙ Setup Check ${forced ? `<a href="#" style="float:right;font-size:11px;font-weight:normal" onclick="send('closeSetupCheck')">✕ Close</a>` : ""}</h2>
${statusBanner}
${rows}
<div class="action-bar">
${canConfirm ? `<button class="btn btn-primary" onclick="send('confirmSetup')">✅ Confirm Setup &amp; Continue</button>` : ""}
<button class="btn btn-secondary" onclick="send('recheckSetup')">🔄 Re-check Setup</button>
${forced ? `<button class="btn btn-secondary" onclick="send('closeSetupCheck')">✕ Close (keep current setup)</button>` : ""}
</div>
<script>
  const vscode = acquireVsCodeApi();
  ${BUSY_BAR_JS}
  function send(cmd, env) { showBusy(); vscode.postMessage({ command: cmd, env: env }); }
  function saveOrgAlias(key) {
    showBusy();
    const el = document.getElementById('alias-' + key);
    vscode.postMessage({ command: 'saveOrgAlias', key: key, value: el ? el.value : '' });
  }
  function loginOrg(key) {
    showBusy();
    const el = document.getElementById('alias-' + key);
    vscode.postMessage({ command: 'loginOrg', key: key, value: el ? el.value : '' });
  }
  function openOrg(alias) {
    if (!alias) { return; }
    vscode.postMessage({ command: 'openOrg', value: alias });
  }
  function openOrgFromInput(key) {
    const el = document.getElementById('alias-' + key);
    openOrg(el ? el.value : '');
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

        const openBtn = (alias: string) => alias
            ? `<button class="org-btn" title="Open ${escapeHtml(alias)} in the browser" onclick="openOrg('${escapeHtml(alias)}')">🌐</button>`
            : "";

        if (!editable) {
            const rows = slots.map(s => `
  <div class="org-row">
    ${statusGlyph(s)}
    <span class="org-label">${escapeHtml(s.label)}</span>
    <span class="org-readonly">${escapeHtml(s.alias) || "(not set)"}</span>
    ${openBtn(s.alias)}
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
    <button class="org-btn" title="Open in the browser" onclick="openOrgFromInput('${s.key}')">🌐</button>
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
  ${BUSY_BAR_CSS}
</style>
</head>
<body>
${BUSY_BAR_HTML}
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
  ${BUSY_BAR_JS}
  function send(cmd) { showBusy(); vscode.postMessage({ command: cmd }); }
</script>
</body>
</html>`;
    }
}

