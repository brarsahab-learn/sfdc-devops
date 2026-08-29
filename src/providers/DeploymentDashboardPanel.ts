// DeploymentDashboardPanel.ts — full-screen "Deployment Dashboard".
// Shows, per environment, what's merged-but-not-deployed since this extension last ran
// a real `sf project deploy` there, grouped by the story/PR that introduced each change,
// as a checkbox tree (left) with a live color-coded diff (right) for whatever's selected.
// No external CI involved — Validate/Deploy run `sf project deploy` directly from here.

import * as vscode from "vscode";
import { GitHelper, warnUncommittedChanges } from "../GitHelper";
import { runDeploy, DeployMode, DeployResult } from "../DeploymentEngine";
import { groupChangesByStory, resolveSelection, DeploySelection, StoryChangeGroup, CommitInfo } from "../DeploymentPlanner";
import { buildPackageXml, AuditChangedFile, metadataTypeForPath } from "../AuditLog";
import { getPromotableEnvironments, getPublishEnvironment, getSourceRootFolder, getDeployTimeoutSeconds, canPromote, ResolvedEnvironment } from "../config";
import { getEffectiveRole } from "../RoleManager";
import { log } from "../Log";

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

interface EnvViewModel {
    env:          ResolvedEnvironment;
    nextEnv?:     ResolvedEnvironment;
    prevEnv?:     ResolvedEnvironment;
    currentSha:   string | null;
    lastDeploy:   { sha: string; deployedAt: string } | null;
    groups:       StoryChangeGroup[];
    allFiles:     AuditChangedFile[];
    diffVsNext:   AuditChangedFile[] | null;
    packageXml:   string;
    unmapped:     string[];
    canDeploy:    boolean;
    orgAliasSet:  boolean;
}

/** One-shot result of the last Validate/Deploy action, shown once as a banner then cleared — same idiom as the one-shot `_focusEnv`. */
interface DeployOutcome {
    env:     string;
    kind:    "validatePassed" | "validateFailed" | "deploySucceeded" | "deployFailed";
    message: string;
    nextEnv?: { name: string; label: string };
    storyCount?: number;
}

export class DeploymentDashboardPanel {
    private static current: DeploymentDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _focusEnv?: string;
    private _lastOutcome?: DeployOutcome;
    /** Fingerprint (sorted file paths, joined) of the last selection that successfully Validated, per env — Deploy is locked until the CURRENT selection matches it exactly. Sticky across renders (unlike _lastOutcome), so it's not just a one-time click-time check: the button re-locks the moment the checked selection changes. */
    private _validatedSelections = new Map<string, string>();

    /** `focusEnv` opens (or brings to front) the dashboard with that environment's tab pre-selected — used by the "🚀 Deploy" link in Story Progress so a merged-but-undeployed story leads straight to the right tab instead of the first one. */
    public static createOrShow(gitHelper: GitHelper, context: vscode.ExtensionContext, focusEnv?: string) {
        if (DeploymentDashboardPanel.current) {
            DeploymentDashboardPanel.current._panel.reveal(vscode.ViewColumn.One);
            if (focusEnv) { DeploymentDashboardPanel.current._focusEnv = focusEnv; }
            DeploymentDashboardPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsDeploymentDashboard",
            "SF DevOps Deployments",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DeploymentDashboardPanel.current = new DeploymentDashboardPanel(panel, gitHelper, context, focusEnv);
    }

    /** Refreshes the dashboard in place if it's currently open — used by the background poller. */
    public static refreshIfOpen() {
        DeploymentDashboardPanel.current?.refresh();
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _gitHelper: GitHelper,
        private readonly _extContext: vscode.ExtensionContext,
        focusEnv?: string
    ) {
        this._panel = panel;
        this._focusEnv = focusEnv;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === "refresh") { await this.refresh(); }
            if (msg.command === "runAction") { await this._runAction(msg); }
            if (msg.command === "viewFileDiff") { await this._viewFileDiff(msg); }
            if (msg.command === "viewPendingFileDiff") { await this._viewPendingFileDiff(msg); }
        }, null, this._disposables);

        this._panel.webview.html = this._loadingHtml();
        this.refresh();
    }

    public dispose() {
        DeploymentDashboardPanel.current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    /** Resolved fresh on every use — "Change Role" can update this at runtime, so it must never be cached. */
    private get _userRole(): string {
        return getEffectiveRole(this._extContext);
    }

    public async refresh() {
        try {
            await this._gitHelper.fetchRemote();
            const envs = getPromotableEnvironments();
            const models: EnvViewModel[] = [];
            for (let i = 0; i < envs.length; i++) {
                const prevEnv = i > 0 ? envs[i - 1] : getPublishEnvironment();
                models.push(await this._buildViewModel(envs[i], envs[i + 1], prevEnv));
            }
            this._panel.webview.html = this._renderHtml(models, this._focusEnv);
            this._focusEnv = undefined; // one-shot: don't keep overriding the user's own tab clicks on later refreshes
        } catch (err) {
            this._panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">Error: ${escapeHtml(String(err))}</body>`;
        }
    }

    private async _buildViewModel(env: ResolvedEnvironment, nextEnv?: ResolvedEnvironment, prevEnv?: ResolvedEnvironment): Promise<EnvViewModel> {
        const sourceRoot = getSourceRootFolder();
        const currentSha = await this._gitHelper.remoteHeadSha(env.branch);
        const lastDeploy  = await this._gitHelper.getDeployState(env.name);

        let groups: StoryChangeGroup[] = [];
        let allFiles: AuditChangedFile[] = [];

        if (lastDeploy && currentSha && lastDeploy.sha !== currentSha) {
            const commits: CommitInfo[] = await this._gitHelper.commitLogBetweenRaw(lastDeploy.sha, `origin/${env.branch}`);
            const filesByHash = new Map<string, AuditChangedFile[]>();
            for (const c of commits) {
                filesByHash.set(c.hash, await this._gitHelper.filesInCommit(c.hash));
            }
            groups = groupChangesByStory(commits, filesByHash);
            allFiles = dedupe(groups.flatMap(g => g.files));
        } else if (!lastDeploy && currentSha) {
            // No baseline recorded yet — nothing to diff from; "ALL" still deploys everything currently on the branch.
            allFiles = [];
        }

        let diffVsNext: AuditChangedFile[] | null = null;
        if (nextEnv) {
            try { diffVsNext = await this._gitHelper.diffNameStatusBetween(env.branch, nextEnv.branch, sourceRoot); }
            catch { diffVsNext = null; }
        }

        const { xml: packageXml, unmapped } = buildPackageXml(allFiles);

        return {
            env, nextEnv, prevEnv, currentSha, lastDeploy, groups, allFiles, diffVsNext, packageXml, unmapped,
            canDeploy:   canPromote(this._userRole, env),
            orgAliasSet: Boolean(env.orgAlias),
        };
    }

    /** Runs one Validate or Deploy step against an already-resolved file selection, and records the outcome (deploy-state + audit log) — shared by a single manual action and each half of an auto-deploy chain. */
    private async _executeStep(
        env: ResolvedEnvironment,
        mode: DeployMode,
        selection: DeploySelection,
        files: AuditChangedFile[],
        summary: string
    ): Promise<DeployResult> {
        const { xml: packageXml, unmapped } = buildPackageXml(files);

        const result = await runDeploy(
            this._gitHelper.getWorkspaceRoot(),
            getSourceRootFolder(),
            selection.mode === "all" ? [] : files.map(f => f.path),
            env.orgAlias ?? "",
            env.deployTestLevel,
            getDeployTimeoutSeconds(),
            mode
        );

        if (result.success && mode === "deploy") {
            const sha = await this._gitHelper.remoteHeadSha(env.branch);
            if (sha) { await this._gitHelper.recordDeployed(env.name, sha, { numberComponentsDeployed: result.numberComponentsDeployed }); }
        }

        await this._gitHelper.appendAudit({
            operation:  mode === "deploy" ? "deploy" : "deployValidate",
            targetEnv:  env.name,
            outcome:    result.success ? "success" : "failure",
            summary:    `${summary} — ${result.success ? "succeeded" : (result.error ?? "failed")}`,
            details:    {
                changedFiles: files, packageXml, unmappedFiles: unmapped,
                deployId: result.deployId, componentFailures: result.componentFailures,
                selectionMode: selection.mode, error: result.error,
            },
        });

        return result;
    }

    private async _runAction(msg: any) {
        const promotable = getPromotableEnvironments();
        const idx = promotable.findIndex(e => e.name === msg.env);
        const env = promotable[idx];
        if (!env) { return; }

        const requestedMode: DeployMode = msg.actionMode === "deploy" ? "deploy" : "validate";
        const selection: DeploySelection = { mode: msg.selectionMode, storyIds: msg.storyIds, files: msg.files };

        // Hard server-side gate — never trust the client's checkbox for Prod, regardless of
        // what the (disabled-in-UI) checkbox somehow sends. Prod always needs a manual Deploy click.
        const autoDeployRequested = Boolean(msg.autoDeployOnSuccess) && !env.isProd;

        const nextEnv = promotable[idx + 1];
        const prevEnv = idx > 0 ? promotable[idx - 1] : getPublishEnvironment();

        // Hard gate: env N-1 must actually be deployed before env N can be Validated/Deployed
        // — skipped for the first promotable env (its "previous stage" is the publish env,
        // which has no deploy step). Same enforcement as the Promote picker's gate, so acting
        // out of order isn't possible from either entry point.
        if (idx > 0) {
            const gap = await this._gitHelper.checkPrevEnvDeployed(prevEnv);
            if (gap.blocked) {
                vscode.window.showWarningMessage(gap.reason!);
                return;
            }
        }

        const model = await this._buildViewModel(env, nextEnv, prevEnv);
        const { files, summary } = resolveSelection(selection, model.groups, model.allFiles);

        // An empty non-"all" selection must never silently fall through to deploying the
        // entire source root (DeploymentEngine treats an empty sourceDirs array as "no
        // restriction") — reject it explicitly instead.
        if (selection.mode !== "all" && files.length === 0) {
            vscode.window.showWarningMessage("No files selected — check at least one file, or use Deploy ALL.");
            return;
        }

        // Hard server-side gate — a standalone manual Deploy is locked until Validate has
        // actually passed for EXACTLY this selection (never trust the client button's enabled
        // state alone). The auto-deploy chain below is exempt: it always runs its own Validate
        // immediately beforehand in the same request, so it's inherently already satisfied.
        if (requestedMode === "deploy") {
            const fp = fingerprintFiles(files);
            if (this._validatedSelections.get(env.name) !== fp) {
                vscode.window.showWarningMessage(`Run Validate on this exact selection for ${env.label} first — Deploy stays locked until it passes for what's currently checked.`);
                return;
            }

            const confirm = await vscode.window.showWarningMessage(
                `${msg.selectionMode === "all" ? "Deploy ALL pending changes" : "Deploy the selected changes"} to ${env.label} (${env.orgAlias})?\n\nThis runs a real Salesforce deployment.`,
                { modal: true },
                "Yes, deploy"
            );
            if (!confirm) { return; }
        }

        if (await this._gitHelper.hasUncommittedChanges()) {
            await warnUncommittedChanges(this._gitHelper, "Commit or stash your local changes before deploying — this checks out a different branch temporarily.");
            return;
        }

        const originalBranch = await this._gitHelper.currentBranch();

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${requestedMode === "deploy" ? "Deploying" : "Validating"} against ${env.label}...`, cancellable: false },
            async () => {
                try {
                    await this._gitHelper.createLocalBranchFrom(env.branch, env.branch);

                    const first = await this._executeStep(env, requestedMode, selection, files, summary);

                    if (requestedMode === "validate" && first.success) {
                        this._validatedSelections.set(env.name, fingerprintFiles(files));
                    }

                    if (requestedMode === "validate" && first.success && autoDeployRequested) {
                        log(`Validate passed — auto-deploying to ${env.label} (auto-deploy enabled)…`);
                        const second = await this._executeStep(env, "deploy", selection, files, summary);
                        if (second.success) { this._validatedSelections.delete(env.name); }
                        this._lastOutcome = second.success
                            ? {
                                env: env.name, kind: "deploySucceeded", message: `Validated and deployed — ${summary}.`,
                                nextEnv: nextEnv ? { name: nextEnv.name, label: nextEnv.label } : undefined,
                                storyCount: countTouchedGroups(model.groups, files),
                              }
                            : { env: env.name, kind: "deployFailed", message: second.error ?? "Auto-deploy failed after a successful validate." };
                        if (second.success) {
                            vscode.window.showInformationMessage(`✅ Validated and auto-deployed to ${env.label} — ${summary}.`);
                        } else {
                            vscode.window.showErrorMessage(`❌ Validate passed but auto-deploy to ${env.label} failed: ${second.error ?? "see the audit trail"}.`);
                        }
                    } else if (requestedMode === "validate") {
                        this._lastOutcome = first.success
                            ? { env: env.name, kind: "validatePassed", message: "Validate passed — Deploy is now unlocked for this selection." }
                            : { env: env.name, kind: "validateFailed", message: first.error ?? "Validation failed." };
                        if (first.success) {
                            vscode.window.showInformationMessage(`✅ Validated against ${env.label} — ${summary}.`);
                        } else {
                            vscode.window.showErrorMessage(`❌ Validation against ${env.label} failed: ${first.error ?? "see component failures in the audit trail"}.`);
                        }
                    } else {
                        if (first.success) { this._validatedSelections.delete(env.name); }
                        this._lastOutcome = first.success
                            ? {
                                env: env.name, kind: "deploySucceeded", message: `Deployed — ${summary}.`,
                                nextEnv: nextEnv ? { name: nextEnv.name, label: nextEnv.label } : undefined,
                                storyCount: countTouchedGroups(model.groups, files),
                              }
                            : { env: env.name, kind: "deployFailed", message: first.error ?? "Deploy failed." };
                        if (first.success) {
                            vscode.window.showInformationMessage(`✅ Deployed against ${env.label} — ${summary}.`);
                        } else {
                            vscode.window.showErrorMessage(`❌ Deploy against ${env.label} failed: ${first.error ?? "see component failures in the audit trail"}.`);
                        }
                    }
                } catch (err) {
                    await this._gitHelper.appendAudit({
                        operation: requestedMode === "deploy" ? "deploy" : "deployValidate",
                        targetEnv: env.name, outcome: "failure",
                        summary: `${requestedMode === "deploy" ? "Deploy" : "Validation"} failed`,
                        details: { error: String(err) },
                    });
                    this._lastOutcome = {
                        env: env.name, kind: requestedMode === "deploy" ? "deployFailed" : "validateFailed",
                        message: String(err),
                    };
                    vscode.window.showErrorMessage(`${requestedMode === "deploy" ? "Deploy" : "Validation"} failed: ${err}`);
                } finally {
                    if (originalBranch) { await this._gitHelper.checkoutBranch(originalBranch).catch(() => {}); }
                    await this.refresh();
                }
            }
        );
    }

    /** Diff between two environment branches — used by the "diff vs next env" preview list. */
    private async _viewFileDiff(msg: { targetEnv: string; beforeRef: string; beforeLabel: string; afterRef: string; afterLabel: string; path: string }) {
        const before = await this._gitHelper.fileContentAtRef(msg.beforeRef, msg.path);
        const after  = await this._gitHelper.fileContentAtRef(msg.afterRef, msg.path);
        this._panel.webview.postMessage({
            command: "fileDiffResult", targetEnv: msg.targetEnv, path: msg.path,
            beforeLabel: msg.beforeLabel, afterLabel: msg.afterLabel,
            before, after, // null means the file doesn't exist at that ref — the client renders that as a whole-file add/delete, not literal text
        });
    }

    /** Diff between what's actually deployed (or the previous stage, if never deployed) and this environment's pending branch content — used by clicking a file row in the left tree. A small targeted lookup, not a full _buildViewModel() rebuild. */
    private async _viewPendingFileDiff(msg: { env: string; path: string }) {
        const promotable = getPromotableEnvironments();
        const idx = promotable.findIndex(e => e.name === msg.env);
        const env = promotable[idx];
        if (!env) { return; }
        const prevEnv = idx > 0 ? promotable[idx - 1] : getPublishEnvironment();
        const lastDeploy = await this._gitHelper.getDeployState(env.name);

        const before = lastDeploy
            ? await this._gitHelper.fileContentAtSha(lastDeploy.sha, msg.path)
            : await this._gitHelper.fileContentAtRef(prevEnv.branch, msg.path);
        const after = await this._gitHelper.fileContentAtRef(env.branch, msg.path);

        this._panel.webview.postMessage({
            command: "fileDiffResult", targetEnv: env.name, path: msg.path,
            beforeLabel: lastDeploy ? `Last deployed to ${env.label} (${lastDeploy.sha.slice(0, 7)})` : `${prevEnv.label} (current)`,
            afterLabel: `${env.label} (pending)`,
            before, after,
        });
    }

    private _loadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Loading deployment status…</body></html>`;
    }

    private _renderHtml(models: EnvViewModel[], focusEnv?: string): string {
        const notificationStrip = models
            .filter(m => m.groups.length > 0 || (m.lastDeploy === null && m.currentSha))
            .map(m => m.groups.length > 0
                ? `<div class="notice">⚠ <b>${escapeHtml(m.env.label)}</b>: ${m.groups.length} story/PR group(s), ${m.allFiles.length} file(s) pending deployment</div>`
                : `<div class="notice muted">ℹ <b>${escapeHtml(m.env.label)}</b>: never deployed from this dashboard yet — "Deploy ALL" will pick up everything currently on the branch</div>`
            ).join("");

        const activeEnv = (focusEnv && models.some(m => m.env.name === focusEnv)) ? focusEnv : (models[0]?.env.name ?? "");
        const envTabs = models.map((m) =>
            `<button class="tab env-tab${m.env.name === activeEnv ? " active" : ""}" data-env="${m.env.name}" onclick="setEnvTab('${m.env.name}')">${escapeHtml(m.env.label)}</button>`
        ).join("");

        const envPanes = models.map(m => this._renderEnvPane(m)).join("\n");
        this._lastOutcome = undefined; // one-shot: shown once, then cleared

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { --bg:#1e1e1e; --fg:#e0e0e0; --card:#252526; --border:#3c3c3c; --muted:#999; --accent:#4fc3f7; --err:#ff6b6b; --ok:#7cd992; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#ffffff; --fg:#1a1a1a; --card:#f5f5f5; --border:#ddd; --muted:#666; --accent:#0078d4; --err:#c62828; --ok:#1b6b2f; }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 0 24px 60px; max-width: 1500px; }
  h1 { font-size: 20px; margin: 0; padding: 20px 0 4px; }
  h2 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 16px; }
  .notice { background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 13px; }
  .notice.muted { border-left-color: var(--muted); color: var(--muted); }

  .tabbar { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin: 8px 0 20px; position: sticky; top: 0; background: var(--bg); z-index: 5; padding-top: 4px; }
  .tab { font-size: 13px; padding: 8px 14px; border: none; background: none; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; }
  .tab:hover { color: var(--fg); }
  .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 600; }

  .pane { display: none; }
  .pane.visible { display: block; }
  section.env { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; }

  .outcome { border-radius: 6px; padding: 8px 12px; margin: 8px 0; font-size: 13px; border: 1px solid var(--border); }
  .outcome a { color: inherit; font-weight: 600; text-decoration: underline; margin-left: 4px; cursor: pointer; }
  .outcome-validatePassed, .outcome-deploySucceeded { background: #2e7d3222; border-color: var(--ok); color: var(--ok); }
  .outcome-validateFailed, .outcome-deployFailed { background: #c6282822; border-color: var(--err); color: var(--err); }

  .split { display: flex; gap: 16px; margin-top: 12px; }
  .split-left { flex: 0 0 35%; min-width: 260px; max-height: 62vh; overflow-y: auto; padding-right: 4px; }
  .split-right { flex: 1 1 65%; min-width: 320px; max-height: 62vh; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; padding: 8px; }

  .story-filter { width: 100%; font-size: 12px; padding: 5px 6px; margin-bottom: 8px; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 4px; }
  .select-row { font-size: 11px; margin-bottom: 6px; }
  .select-row a { color: var(--accent); cursor: pointer; text-decoration: none; }
  .select-row a:hover { text-decoration: underline; }
  .selection-summary { font-size: 11px; color: var(--muted); margin-bottom: 8px; }

  .type-group { margin-bottom: 6px; }
  .type-group summary { cursor: pointer; font-weight: 600; font-size: 12px; padding: 3px 0; }
  ul.files { list-style: none; margin: 4px 0 4px 8px; padding: 0; font-size: 12px; }
  ul.files li { padding: 2px 0; display: flex; align-items: center; gap: 6px; }
  ul.files li.clickable { cursor: pointer; }
  ul.files li.clickable:hover { color: var(--accent); }
  .tree-row input[type=checkbox] { flex-shrink: 0; }
  .file-path { flex: 1; word-break: break-all; }
  .file-path.clickable { cursor: pointer; }
  .file-path.clickable:hover { color: var(--accent); text-decoration: underline; }
  .story-badge { font-size: 10px; color: var(--muted); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; flex-shrink: 0; }

  .change { font-size: 10px; text-transform: uppercase; border-radius: 3px; padding: 1px 5px; flex-shrink: 0; opacity: 0.8; }
  .change.added { background: #2e7d3222; color: #4caf50; }
  .change.modified { background: #f9a82522; color: #ffa726; }
  .change.deleted { background: #c6282822; color: var(--err); }

  .group { border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; }
  .group-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .shared { font-size: 11px; color: var(--err); margin-left: 6px; font-weight: normal; }

  .deploy-row { display: flex; align-items: center; gap: 10px; margin-top: 14px; flex-wrap: wrap; }
  .auto-deploy-label { font-size: 12px; display: flex; align-items: center; gap: 6px; }
  .auto-deploy-label .meta { margin: 0; }

  .actions { display: flex; gap: 8px; margin-top: 12px; }
  .btn { font-size: 12px; padding: 7px 14px; border-radius: 6px; border: none; cursor: pointer; }
  .btn-primary { background: #0078d4; color: white; }
  .btn-primary.btn-highlight { box-shadow: 0 0 0 2px var(--ok); }
  .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--fg); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .warn { color: #ffab70; font-size: 12px; margin-top: 8px; }
  details.diff { margin-top: 14px; }
  details.diff summary { cursor: pointer; font-weight: 600; }
  pre.manifest { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; overflow-x: auto; font-size: 11px; max-height: 220px; }

  .diffTitle { font-weight: 600; font-size: 13px; margin-bottom: 2px; }
  .diffMeta { margin-bottom: 6px; }
  .diffStat { font-size: 12px; margin: 2px 0 10px; }
  .diffStat .plus { color: var(--ok); }
  .diffStat .minus { color: var(--err); }
  .diffBody { font-family: var(--vscode-editor-font-family, "SF Mono", Consolas, monospace); font-size: 12px; }
  .diffline { display: flex; white-space: pre; }
  .diffline .gutter { flex: 0 0 88px; text-align: right; padding: 0 10px; color: var(--muted); opacity: 0.7; user-select: none; border-right: 1px solid var(--border); }
  .diffline .marker { flex: 0 0 18px; text-align: center; opacity: 0.8; user-select: none; }
  .diffline .txt { flex: 1; padding-right: 12px; overflow-x: visible; }
  .diffline.diff-add { background: #2e7d3222; }
  .diffline.diff-add .marker, .diffline.diff-add .txt { color: #4caf50; }
  .diffline.diff-del { background: #c6282822; }
  .diffline.diff-del .marker, .diffline.diff-del .txt { color: var(--err); }
  .diffline.diff-same .txt { color: var(--fg); opacity: 0.85; }
  .diffline.diff-context { justify-content: center; color: var(--muted); padding: 2px 0; font-size: 11px; }
</style>
</head>
<body>
<h1>SF DevOps Deployments</h1>
<div class="sub">Everything merged into an environment branch, not yet deployed by this extension. Deploys and validations run <code>sf project deploy</code> directly — no external CI involved.</div>

${notificationStrip}

<div class="tabbar">
  ${envTabs}
</div>

${envPanes}

<script>
  const vscode = acquireVsCodeApi();
  let activeEnv = ${JSON.stringify(activeEnv)};

  function send(command, payload) { vscode.postMessage(Object.assign({ command }, payload)); }
  function refresh() { send('refresh'); }

  function applyTabs() {
    document.querySelectorAll('.pane').forEach(function (p) {
      p.classList.toggle('visible', p.dataset.env === activeEnv);
    });
  }

  function setEnvTab(e) {
    activeEnv = e;
    document.querySelectorAll('.tab.env-tab').forEach(function (b) { b.classList.toggle('active', b.dataset.env === e); });
    applyTabs();
  }

  function toggleFile(env) { recomputeSelection(env); }

  function currentFingerprint(env) {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.file-check[data-env="' + env + '"]:checked'));
    return boxes.map(function (b) { return b.value; }).sort().join('|');
  }

  // Deploy stays locked (regardless of org/role) until the CURRENTLY checked selection is
  // byte-for-byte what Validate last passed for that env — re-evaluated on every checkbox
  // change, so unchecking even one file re-locks it immediately. The server enforces this too
  // (never trust a client-side disabled attribute alone) — this is what keeps the UI honest.
  // Returns whether it's unlocked, so recomputeSelection can tell the user what to do next.
  function updateDeployButtonState(env) {
    var pane = document.querySelector('.pane[data-env="' + env + '"]');
    var btn = document.getElementById('deployBtn-' + env);
    if (!pane || !btn) { return false; }
    var hasValidated = pane.dataset.hasValidated === '1';
    var matches = hasValidated && currentFingerprint(env) === (pane.dataset.validatedFp || '');
    btn.disabled = btn.dataset.hardDisabled === '1' || !matches;
    btn.title = matches ? '' : 'Run Validate on this exact selection first';
    btn.classList.toggle('btn-highlight', matches && btn.dataset.hardDisabled !== '1');
    return matches;
  }

  function recomputeSelection(env) {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.file-check[data-env="' + env + '"]:checked'));
    var stories = {};
    boxes.forEach(function (b) {
      var row = b.closest('.tree-row');
      var s = row ? row.dataset.stories : '';
      (s ? s.split(',') : []).forEach(function (id) { if (id) { stories[id] = true; } });
    });
    var ready = updateDeployButtonState(env); // must run before building the summary text below
    var summaryEl = document.getElementById('selSummary-' + env);
    if (summaryEl) {
      if (boxes.length === 0) {
        summaryEl.textContent = 'No files selected.';
      } else {
        var base = boxes.length + ' file(s) selected across ' + Object.keys(stories).length + ' story/PR group(s).';
        summaryEl.textContent = base + (ready ? ' Ready — click Deploy.' : ' Next: click Validate.');
      }
    }
  }

  // Respects the current story/PR filter — only (de)selects rows that are currently visible.
  function selectAll(env, checked) {
    document.querySelectorAll('.file-check[data-env="' + env + '"]').forEach(function (cb) {
      var row = cb.closest('.tree-row');
      if (!row || row.style.display !== 'none') { cb.checked = checked; }
    });
    recomputeSelection(env);
  }

  function filterTree(env) {
    var sel = document.querySelector('.story-filter[data-env="' + env + '"]');
    var val = sel ? sel.value : '';
    document.querySelectorAll('.tree-row[data-env="' + env + '"]').forEach(function (row) {
      var stories = (row.dataset.stories || '').split(',');
      row.style.display = (!val || stories.indexOf(val) !== -1) ? '' : 'none';
    });
    document.querySelectorAll('.type-group[data-env="' + env + '"]').forEach(function (grp) {
      var anyVisible = Array.prototype.some.call(grp.querySelectorAll('.tree-row'), function (r) { return r.style.display !== 'none'; });
      grp.style.display = anyVisible ? '' : 'none';
    });
  }

  function runAction(env, actionMode) {
    var boxes = Array.prototype.slice.call(document.querySelectorAll('.file-check[data-env="' + env + '"]:checked'));
    var files = boxes.map(function (b) { return b.value; });
    var autoCb = document.getElementById('autoDeploy-' + env);
    var autoDeployOnSuccess = Boolean(autoCb && autoCb.checked);
    send('runAction', { env: env, actionMode: actionMode, selectionMode: 'files', files: files, autoDeployOnSuccess: autoDeployOnSuccess });
  }

  // Used only when the tree is empty (never deployed before) — nothing to individually check.
  function bootstrapAction(env, actionMode) {
    var autoCb = document.getElementById('autoDeploy-' + env);
    var autoDeployOnSuccess = Boolean(autoCb && autoCb.checked);
    send('runAction', { env: env, actionMode: actionMode, selectionMode: 'all', autoDeployOnSuccess: autoDeployOnSuccess });
  }

  function viewFileDiff(targetEnv, beforeRef, beforeLabel, afterRef, afterLabel, path) {
    send('viewFileDiff', { targetEnv: targetEnv, beforeRef: beforeRef, beforeLabel: beforeLabel, afterRef: afterRef, afterLabel: afterLabel, path: path });
  }

  function viewPendingFileDiff(env, path) {
    send('viewPendingFileDiff', { env: env, path: path });
  }

  function escapeHtmlJs(s) {
    return String(s).replace(/[<>&]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]; });
  }

  // Line-level LCS diff. Guarded by size since it's O(lines_a * lines_b) time and memory —
  // past that it falls back to a plain whole-file replace view instead of hanging the tab.
  var DIFF_CELL_LIMIT = 4000000;
  function computeLineDiff(a, b) {
    var n = a.length, m = b.length;
    if (n * m > DIFF_CELL_LIMIT) { return null; }
    var dp = new Array(n + 1);
    for (var i = 0; i <= n; i++) { dp[i] = new Uint32Array(m + 1); }
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var result = [];
    i = 0; var j2 = 0;
    while (i < n && j2 < m) {
      if (a[i] === b[j2]) { result.push({ type: 'same', line: a[i] }); i++; j2++; }
      else if (dp[i + 1][j2] >= dp[i][j2 + 1]) { result.push({ type: 'del', line: a[i] }); i++; }
      else { result.push({ type: 'add', line: b[j2] }); j2++; }
    }
    while (i < n) { result.push({ type: 'del', line: a[i] }); i++; }
    while (j2 < m) { result.push({ type: 'add', line: b[j2] }); j2++; }
    return result;
  }

  var CONTEXT_LINES = 3;
  var COLLAPSE_AFTER = 8;

  function renderDiffLines(entries) {
    var html = [];
    var aNo = 0, bNo = 0;
    var added = 0, deleted = 0;
    var run = []; // buffered consecutive 'same' entries, so a long unchanged stretch can collapse

    function flushRun() {
      if (run.length === 0) { return; }
      if (run.length <= COLLAPSE_AFTER) {
        run.forEach(function (r) { html.push(r.html); });
      } else {
        for (var k = 0; k < CONTEXT_LINES; k++) { html.push(run[k].html); }
        html.push('<div class="diffline diff-context">⋯ ' + (run.length - 2 * CONTEXT_LINES) + ' unchanged line(s) ⋯</div>');
        for (var k2 = run.length - CONTEXT_LINES; k2 < run.length; k2++) { html.push(run[k2].html); }
      }
      run = [];
    }

    entries.forEach(function (e) {
      if (e.type === 'same') {
        aNo++; bNo++;
        var gutter = String(aNo).padStart(4, ' ') + ' ' + String(bNo).padStart(4, ' ');
        run.push({ html: '<div class="diffline diff-same"><span class="gutter">' + gutter + '</span><span class="marker"> </span><span class="txt">' + escapeHtmlJs(e.line) + '</span></div>' });
        return;
      }
      flushRun();
      if (e.type === 'add') {
        bNo++; added++;
        var g = '     ' + String(bNo).padStart(4, ' ');
        html.push('<div class="diffline diff-add"><span class="gutter">' + g + '</span><span class="marker">+</span><span class="txt">' + escapeHtmlJs(e.line) + '</span></div>');
      } else {
        aNo++; deleted++;
        var g2 = String(aNo).padStart(4, ' ') + '     ';
        html.push('<div class="diffline diff-del"><span class="gutter">' + g2 + '</span><span class="marker">-</span><span class="txt">' + escapeHtmlJs(e.line) + '</span></div>');
      }
    });
    flushRun();

    return { html: html.join(''), added: added, deleted: deleted };
  }

  function splitLines(text) { return text.length ? text.split('\\n') : []; }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.command === 'fileDiffResult') {
      var titleEl = document.getElementById('diffTitle-' + msg.targetEnv);
      var metaEl  = document.getElementById('diffMeta-' + msg.targetEnv);
      var bodyEl  = document.getElementById('diffBody-' + msg.targetEnv);
      var statEl  = document.getElementById('diffStat-' + msg.targetEnv);
      if (!titleEl || !bodyEl) { return; }
      titleEl.textContent = msg.path;
      metaEl.textContent = msg.beforeLabel + '  →  ' + msg.afterLabel;

      if (msg.before === msg.after) {
        bodyEl.innerHTML = '<div class="diffline diff-context">No differences.</div>';
        statEl.innerHTML = '';
      } else if (msg.before === null) {
        var addLines = splitLines(msg.after || '');
        bodyEl.innerHTML = addLines.map(function (l, idx) {
          return '<div class="diffline diff-add"><span class="gutter">     ' + String(idx + 1).padStart(4, ' ') + '</span><span class="marker">+</span><span class="txt">' + escapeHtmlJs(l) + '</span></div>';
        }).join('');
        statEl.innerHTML = '<b>New file</b> — <span class="plus">+' + addLines.length + '</span>';
      } else if (msg.after === null) {
        var delLines = splitLines(msg.before || '');
        bodyEl.innerHTML = delLines.map(function (l, idx) {
          return '<div class="diffline diff-del"><span class="gutter">' + String(idx + 1).padStart(4, ' ') + '     </span><span class="marker">-</span><span class="txt">' + escapeHtmlJs(l) + '</span></div>';
        }).join('');
        statEl.innerHTML = '<b>Deleted</b> — <span class="minus">-' + delLines.length + '</span>';
      } else {
        var diff = computeLineDiff(splitLines(msg.before), splitLines(msg.after));
        if (diff === null) {
          bodyEl.innerHTML = '<div class="diffline diff-context">File too large to diff line-by-line — showing raw content instead.</div>'
            + '<pre style="white-space:pre-wrap;padding:8px;margin:0">' + escapeHtmlJs(msg.before) + '\\n---\\n' + escapeHtmlJs(msg.after) + '</pre>';
          statEl.innerHTML = '';
        } else {
          var rendered = renderDiffLines(diff);
          bodyEl.innerHTML = rendered.html;
          statEl.innerHTML = '<span class="plus">+' + rendered.added + '</span>&nbsp;&nbsp;<span class="minus">-' + rendered.deleted + '</span>';
        }
      }
    }
  });

  applyTabs();
  document.querySelectorAll('.pane').forEach(function (p) {
    recomputeSelection(p.dataset.env); // also sets the initial Deploy-button lock state per env
  });
</script>
</body>
</html>`;
    }

    /** Unified per-environment pane: header, outcome banner, 35/65 split (checkbox tree + live diff), Validate/Deploy actions. */
    private _renderEnvPane(m: EnvViewModel): string {
        const env = m.env;
        const shortSha = (s: string | null) => s ? s.slice(0, 7) : "—";
        const lastDeployText = m.lastDeploy
            ? `Last deployed <code>${shortSha(m.lastDeploy.sha)}</code> on ${new Date(m.lastDeploy.deployedAt).toLocaleString()}`
            : `Never deployed from this dashboard`;

        const noticeIfNoOrg = m.orgAliasSet ? "" : `<div class="warn">⚠ No org alias set for ${escapeHtml(env.label)} — set sfDevops.environments[].orgAlias to enable deploy/validate here.</div>`;
        const noticeIfNoRole = m.canDeploy ? "" : `<div class="warn">⚠ Your role can't deploy to ${escapeHtml(env.label)} (requires "${escapeHtml(env.requiredRole ?? "")}").</div>`;
        const disabled = (!m.orgAliasSet || !m.canDeploy) ? "disabled" : "";

        const outcome = this._lastOutcome && this._lastOutcome.env === env.name ? this._lastOutcome : undefined;
        const outcomeHtml = outcome
            ? `<div class="outcome outcome-${outcome.kind}">${escapeHtml(outcome.message)}${
                outcome.nextEnv
                    ? ` <a onclick="setEnvTab('${outcome.nextEnv.name}')">→ ${escapeHtml(outcome.nextEnv.label)} (${outcome.storyCount ?? 0} story/PR group(s) ready)</a>`
                    : ""
              }</div>`
            : "";
        // Deploy's actual enabled/disabled state is driven live by client-side JS (see
        // updateDeployButtonState) so it reacts the instant checkboxes change — this is only
        // the "hard" reasons that never change without a fresh render (no org alias, no role).
        const validatedFingerprint = this._validatedSelections.get(env.name) ?? null;
        // A successful Validate triggers a full refresh(), which re-renders the tree with every
        // checkbox back to unchecked — without restoring the validated selection here, Deploy
        // would immediately re-lock itself right after Validate passed, forcing the user to
        // re-check the exact same files for no reason. Pre-checking them keeps it unlocked.
        const validatedPaths = validatedFingerprint !== null
            ? new Set(validatedFingerprint.split("|").filter(Boolean))
            : null;

        // Group pending files by Salesforce metadata type for the tree, and note which story/PR
        // group(s) touch each file (a file can be shared — see StoryChangeGroup.sharedWith).
        const storiesByPath = new Map<string, string[]>();
        for (const g of m.groups) {
            for (const f of g.files) {
                const arr = storiesByPath.get(f.path) ?? [];
                arr.push(g.storyId);
                storiesByPath.set(f.path, arr);
            }
        }
        const byType = new Map<string, AuditChangedFile[]>();
        const unmappedFiles: AuditChangedFile[] = [];
        for (const f of m.allFiles) {
            const type = metadataTypeForPath(f.path);
            if (type) {
                if (!byType.has(type)) { byType.set(type, []); }
                byType.get(type)!.push(f);
            } else {
                unmappedFiles.push(f);
            }
        }
        const renderFileRow = (f: AuditChangedFile) => {
            const stories = storiesByPath.get(f.path) ?? [];
            const checked = validatedPaths?.has(f.path) ? " checked" : "";
            return `<li class="tree-row" data-env="${env.name}" data-stories="${stories.map(escapeHtml).join(",")}">
          <input type="checkbox" class="file-check" data-env="${env.name}" value="${escapeHtml(f.path)}"${checked} onchange="toggleFile('${env.name}')">
          <span class="change ${f.change}">${f.change}</span>
          <span class="file-path clickable" onclick="viewPendingFileDiff('${env.name}','${escapeHtml(f.path)}')" title="Preview diff">${escapeHtml(f.path)}</span>
          ${stories.length ? `<span class="story-badge" title="story/PR">${stories.map(escapeHtml).join(", ")}</span>` : ""}
        </li>`;
        };
        const typeGroupsHtml = Array.from(byType.keys()).sort().map(type => `
      <details class="type-group" data-env="${env.name}" open>
        <summary>${escapeHtml(type)} (${byType.get(type)!.length})</summary>
        <ul class="files">${byType.get(type)!.map(renderFileRow).join("")}</ul>
      </details>`).join("");
        const unmappedHtml = unmappedFiles.length
            ? `<details class="type-group" data-env="${env.name}" open>
             <summary>Other (${unmappedFiles.length})</summary>
             <ul class="files">${unmappedFiles.map(renderFileRow).join("")}</ul>
           </details>`
            : "";

        const neverDeployed = m.allFiles.length === 0 && !m.lastDeploy && m.currentSha;
        // Bootstrap mode has no checkboxes to react to, so (unlike the main Deploy button)
        // this one's gate is computed once, server-side, per render — "" is the fingerprint
        // of an empty selection, i.e. what "Validate ALL" records when there's nothing tracked.
        const bootstrapDeployDisabled = Boolean(disabled) || validatedFingerprint !== "";
        const bootstrapHtml = neverDeployed
            ? `<div class="meta">Never deployed from this dashboard yet — nothing to individually select.</div>
           <div class="actions">
             <button class="btn btn-secondary" ${disabled} onclick="bootstrapAction('${env.name}','validate')">🔍 Validate ALL</button>
             <button class="btn btn-primary" ${bootstrapDeployDisabled ? "disabled" : ""} onclick="bootstrapAction('${env.name}','deploy')" title="${validatedFingerprint === "" ? "" : "Run Validate ALL first"}">🚀 Deploy ALL (nothing tracked yet)</button>
           </div>`
            : "";
        const upToDateHtml = (m.allFiles.length === 0 && !neverDeployed)
            ? `<div class="meta">No pending changes — ${escapeHtml(env.label)} is up to date.</div>`
            : "";

        const filterOptions = m.groups.map(g => `<option value="${escapeHtml(g.storyId)}">${escapeHtml(g.storyId)} (${g.files.length})</option>`).join("");

        const diffVsNextBlock = m.nextEnv
            ? `<details class="diff">
          <summary>Preview diff: ${escapeHtml(env.label)} vs ${escapeHtml(m.nextEnv.label)} (${m.diffVsNext?.length ?? 0} file(s) different)</summary>
          <ul class="files">
            ${(m.diffVsNext ?? []).map(f => `<li class="clickable" onclick="viewFileDiff('${env.name}','${env.branch}','${escapeHtml(env.label)}','${m.nextEnv!.branch}','${escapeHtml(m.nextEnv!.label)}','${escapeHtml(f.path)}')"><span class="change ${f.change}">${f.change}</span>${escapeHtml(f.path)}</li>`).join("")}
          </ul>
        </details>`
            : "";

        const manifestBlock = m.allFiles.length
            ? `<details class="diff"><summary>package.xml preview (${m.allFiles.length} file(s))</summary><pre class="manifest">${escapeHtml(m.packageXml)}</pre>${m.unmapped.length ? `<div class="warn">Not in manifest: ${m.unmapped.map(escapeHtml).join(", ")}</div>` : ""}</details>`
            : "";

        return `
<div class="pane" data-env="${env.name}" data-has-validated="${validatedFingerprint !== null ? "1" : "0"}" data-validated-fp="${escapeHtml(validatedFingerprint ?? "")}">
<section class="env">
  <h2>${escapeHtml(env.label)} <span class="meta">(${escapeHtml(env.branch)} → ${escapeHtml(env.orgAlias || "no org alias")})</span></h2>
  <div class="meta">${lastDeployText}</div>
  ${noticeIfNoOrg}${noticeIfNoRole}
  ${outcomeHtml}

  <div class="split">
    <div class="split-left">
      ${m.groups.length ? `<select class="story-filter" data-env="${env.name}" onchange="filterTree('${env.name}')">
        <option value="">All stories/PRs (${m.groups.length})</option>
        ${filterOptions}
      </select>` : ""}

      ${m.allFiles.length ? `<div class="select-row">
        <a onclick="selectAll('${env.name}', true)">Select all</a> ·
        <a onclick="selectAll('${env.name}', false)">Select none</a>
      </div>` : ""}

      <div class="selection-summary" id="selSummary-${env.name}">No files selected.</div>

      <div class="tree" id="tree-${env.name}">
        ${typeGroupsHtml}${unmappedHtml}
        ${bootstrapHtml}${upToDateHtml}
      </div>

      ${diffVsNextBlock}
      ${manifestBlock}
    </div>

    <div class="split-right">
      <div class="diffTitle" id="diffTitle-${env.name}">Select a file on the left to preview its diff.</div>
      <div class="meta diffMeta" id="diffMeta-${env.name}"></div>
      <div class="diffStat" id="diffStat-${env.name}"></div>
      <div class="diffBody" id="diffBody-${env.name}"></div>
    </div>
  </div>

  <div class="deploy-row">
    <label class="auto-deploy-label" title="${env.isProd ? "Prod always requires a manual Deploy click, regardless of this checkbox." : "If Validate succeeds, immediately run a real Deploy with the same selection."}">
      <input type="checkbox" id="autoDeploy-${env.name}" ${env.isProd ? "disabled" : ""}>
      Auto-deploy on success
      ${env.isProd ? `<span class="meta">(Prod always requires a manual Deploy click)</span>` : ""}
    </label>
    <button class="btn btn-secondary" ${disabled} onclick="runAction('${env.name}','validate')">🔍 Validate</button>
    <button class="btn btn-primary" id="deployBtn-${env.name}" data-hard-disabled="${disabled ? "1" : "0"}" disabled title="Run Validate on this exact selection first">🚀 Deploy</button>
  </div>
</section>
</div>`;
    }
}

function dedupe(files: AuditChangedFile[]): AuditChangedFile[] {
    const seen = new Map<string, AuditChangedFile>();
    for (const f of files) { seen.set(f.path, f); }
    return Array.from(seen.values());
}

/** How many story/PR groups the given files touch — used for the "N story/PR(s) ready" banner text. Exact for "all"/"stories" selections; an honest approximation for a partial file-mode selection. */
function countTouchedGroups(groups: StoryChangeGroup[], files: AuditChangedFile[]): number {
    const paths = new Set(files.map(f => f.path));
    return groups.filter(g => g.files.some(f => paths.has(f.path))).length;
}

/** Identifies a file selection by its exact contents (order-independent) — used to check whether Deploy's current selection is exactly what Validate last passed for. */
function fingerprintFiles(files: AuditChangedFile[]): string {
    return files.map(f => f.path).sort().join("|");
}
