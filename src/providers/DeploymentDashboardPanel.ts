// DeploymentDashboardPanel.ts — full-screen "Deployment Dashboard".
// Shows, per environment, what's merged-but-not-deployed since this extension last ran
// a real `sf project deploy` there, grouped by the story/PR that introduced each change,
// and lets the user deploy ALL / by story / by hand-picked file. No external CI involved.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { runDeploy, DeployMode } from "../DeploymentEngine";
import { groupChangesByStory, resolveSelection, DeploySelection, StoryChangeGroup, CommitInfo } from "../DeploymentPlanner";
import { buildPackageXml, AuditChangedFile } from "../AuditLog";
import { getPromotableEnvironments, getSourceRootFolder, getDeployTimeoutSeconds, canPromote, ResolvedEnvironment } from "../config";

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

interface EnvViewModel {
    env:          ResolvedEnvironment;
    nextEnv?:     ResolvedEnvironment;
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

export class DeploymentDashboardPanel {
    private static current: DeploymentDashboardPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(gitHelper: GitHelper, userRole: string) {
        if (DeploymentDashboardPanel.current) {
            DeploymentDashboardPanel.current._panel.reveal(vscode.ViewColumn.One);
            DeploymentDashboardPanel.current.refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsDeploymentDashboard",
            "SF DevOps Deployments",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DeploymentDashboardPanel.current = new DeploymentDashboardPanel(panel, gitHelper, userRole);
    }

    /** Refreshes the dashboard in place if it's currently open — used by the background poller. */
    public static refreshIfOpen() {
        DeploymentDashboardPanel.current?.refresh();
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _gitHelper: GitHelper,
        private readonly _userRole: string
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === "refresh") { await this.refresh(); }
            if (msg.command === "runAction") { await this._runAction(msg); }
            if (msg.command === "viewFileDiff") { await this._viewFileDiff(msg); }
        }, null, this._disposables);

        this._panel.webview.html = this._loadingHtml();
        this.refresh();
    }

    public dispose() {
        DeploymentDashboardPanel.current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    public async refresh() {
        try {
            await this._gitHelper.fetchRemote();
            const envs = getPromotableEnvironments();
            const models: EnvViewModel[] = [];
            for (let i = 0; i < envs.length; i++) {
                models.push(await this._buildViewModel(envs[i], envs[i + 1]));
            }
            this._panel.webview.html = this._renderHtml(models);
        } catch (err) {
            this._panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">Error: ${escapeHtml(String(err))}</body>`;
        }
    }

    private async _buildViewModel(env: ResolvedEnvironment, nextEnv?: ResolvedEnvironment): Promise<EnvViewModel> {
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
            env, nextEnv, currentSha, lastDeploy, groups, allFiles, diffVsNext, packageXml, unmapped,
            canDeploy:   canPromote(this._userRole, env),
            orgAliasSet: Boolean(env.orgAlias),
        };
    }

    private async _runAction(msg: any) {
        const envs = getPromotableEnvironments();
        const env = envs.find(e => e.name === msg.env);
        if (!env) { return; }
        const mode: DeployMode = msg.actionMode === "deploy" ? "deploy" : "validate";
        const selection: DeploySelection = { mode: msg.selectionMode, storyIds: msg.storyIds, files: msg.files };

        if (mode === "deploy") {
            const confirm = await vscode.window.showWarningMessage(
                `${msg.selectionMode === "all" ? "Deploy ALL pending changes" : "Deploy the selected changes"} to ${env.label} (${env.orgAlias})?\n\nThis runs a real Salesforce deployment.`,
                { modal: true },
                "Yes, deploy"
            );
            if (!confirm) { return; }
        }

        if (await this._gitHelper.hasUncommittedChanges()) {
            vscode.window.showWarningMessage("Commit or stash your local changes before deploying — this checks out a different branch temporarily.");
            return;
        }

        const originalBranch = await this._gitHelper.currentBranch();

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `${mode === "deploy" ? "Deploying" : "Validating"} against ${env.label}...`, cancellable: false },
            async () => {
                try {
                    const model = await this._buildViewModel(env, undefined);
                    const { files, summary } = resolveSelection(selection, model.groups, model.allFiles);
                    const { xml: packageXml, unmapped } = buildPackageXml(files);

                    await this._gitHelper.createLocalBranchFrom(env.branch, env.branch);

                    const result = await runDeploy(
                        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
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

                    if (result.success) {
                        vscode.window.showInformationMessage(`✅ ${mode === "deploy" ? "Deployed" : "Validated"} against ${env.label} — ${summary}.`);
                    } else {
                        vscode.window.showErrorMessage(`❌ ${mode === "deploy" ? "Deploy" : "Validation"} against ${env.label} failed: ${result.error ?? "see component failures in the audit trail"}.`);
                    }
                } catch (err) {
                    await this._gitHelper.appendAudit({
                        operation: mode === "deploy" ? "deploy" : "deployValidate",
                        targetEnv: env.name, outcome: "failure",
                        summary: `${mode === "deploy" ? "Deploy" : "Validation"} failed`,
                        details: { error: String(err) },
                    });
                    vscode.window.showErrorMessage(`${mode === "deploy" ? "Deploy" : "Validation"} failed: ${err}`);
                } finally {
                    if (originalBranch) { await this._gitHelper.checkoutBranch(originalBranch).catch(() => {}); }
                    await this.refresh();
                }
            }
        );
    }

    private async _viewFileDiff(msg: { env: string; nextEnv: string; path: string }) {
        const before = await this._gitHelper.fileContentAtRef(msg.env, msg.path);
        const after  = await this._gitHelper.fileContentAtRef(msg.nextEnv, msg.path);
        this._panel.webview.postMessage({
            command: "fileDiffResult", path: msg.path,
            before: before ?? "(does not exist)", after: after ?? "(does not exist)",
        });
    }

    private _loadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Loading deployment status…</body></html>`;
    }

    private _renderHtml(models: EnvViewModel[]): string {
        const notificationStrip = models
            .filter(m => m.groups.length > 0 || (m.lastDeploy === null && m.currentSha))
            .map(m => m.groups.length > 0
                ? `<div class="notice">⚠ <b>${escapeHtml(m.env.label)}</b>: ${m.groups.length} story/PR group(s), ${m.allFiles.length} file(s) pending deployment</div>`
                : `<div class="notice muted">ℹ <b>${escapeHtml(m.env.label)}</b>: never deployed from this dashboard yet — "Deploy ALL" will pick up everything currently on the branch</div>`
            ).join("");

        const sections = models.map(m => this._renderEnvSection(m)).join("\n");

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
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 20px 24px 60px; max-width: 1100px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .sub { color: var(--muted); font-size: 12px; margin-bottom: 20px; }
  .notice { background: var(--card); border: 1px solid var(--border); border-left: 3px solid var(--accent); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; font-size: 13px; }
  .notice.muted { border-left-color: var(--muted); color: var(--muted); }
  section.env { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px 20px; margin-bottom: 24px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .group { border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; margin-bottom: 8px; }
  .group-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
  .shared { font-size: 11px; color: var(--err); margin-left: 6px; font-weight: normal; }
  ul.files { list-style: none; margin: 6px 0 0 24px; padding: 0; font-size: 12px; }
  ul.files li { padding: 2px 0; cursor: pointer; }
  ul.files li:hover { color: var(--accent); }
  .change { font-size: 10px; text-transform: uppercase; border-radius: 3px; padding: 1px 5px; margin-right: 6px; opacity: 0.8; }
  .change.added { background: #2e7d3222; color: #4caf50; }
  .change.modified { background: #f9a82522; color: #ffa726; }
  .change.deleted { background: #c6282822; color: var(--err); }
  .mode-row { display: flex; gap: 6px; margin: 10px 0; }
  .mode-row button { font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); cursor: pointer; }
  .mode-row button.active { border-color: var(--accent); color: var(--accent); }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  .btn { font-size: 12px; padding: 7px 14px; border-radius: 6px; border: none; cursor: pointer; }
  .btn-primary { background: #0078d4; color: white; }
  .btn-secondary { background: transparent; border: 1px solid var(--border); color: var(--fg); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .warn { color: #ffab70; font-size: 12px; margin-top: 8px; }
  details.diff { margin-top: 14px; }
  details.diff summary { cursor: pointer; font-weight: 600; }
  pre.manifest { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; overflow-x: auto; font-size: 11px; max-height: 220px; }
  #diffModal { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); align-items: center; justify-content: center; z-index: 10; }
  #diffModal .box { background: var(--card); border: 1px solid var(--border); border-radius: 8px; width: 90%; max-width: 1000px; max-height: 80vh; overflow: auto; padding: 16px; }
  #diffModal .cols { display: flex; gap: 12px; }
  #diffModal pre { flex: 1; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; overflow: auto; font-size: 11px; max-height: 60vh; white-space: pre-wrap; }
  #diffModal .close { float: right; cursor: pointer; }
</style>
</head>
<body>
<h1>SF DevOps Deployments</h1>
<div class="sub">Everything merged into an environment branch, not yet deployed by this extension. Deploys and validations run <code>sf project deploy</code> directly — no external CI involved.</div>

${notificationStrip}

${sections}

<div id="diffModal">
  <div class="box">
    <span class="close" onclick="closeDiff()">✕ close</span>
    <h3 id="diffTitle"></h3>
    <div class="cols">
      <div><div class="meta" id="beforeLabel"></div><pre id="beforePre"></pre></div>
      <div><div class="meta" id="afterLabel"></div><pre id="afterPre"></pre></div>
    </div>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const state = {};

  function send(command, payload) { vscode.postMessage(Object.assign({ command }, payload)); }
  function refresh() { send('refresh'); }

  function setMode(env, mode) {
    state[env] = state[env] || {};
    state[env].mode = mode;
    document.querySelectorAll('[data-env="' + env + '"].mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    document.querySelectorAll('[data-env="' + env + '"].group-check, [data-env="' + env + '"].file-check').forEach(el => {
      el.closest('.picker').style.display = el.closest('.picker').dataset.for === mode ? 'block' : 'none';
    });
  }

  function collectSelection(env) {
    const mode = (state[env] && state[env].mode) || 'all';
    if (mode === 'stories') {
      const storyIds = Array.prototype.slice.call(document.querySelectorAll('[data-env="' + env + '"].group-check:checked')).map(el => el.value);
      return { selectionMode: 'stories', storyIds };
    }
    if (mode === 'files') {
      const files = Array.prototype.slice.call(document.querySelectorAll('[data-env="' + env + '"].file-check:checked')).map(el => el.value);
      return { selectionMode: 'files', files };
    }
    return { selectionMode: 'all' };
  }

  function runAction(env, actionMode) {
    const sel = collectSelection(env);
    send('runAction', Object.assign({ env, actionMode }, sel));
  }

  function viewFileDiff(env, nextEnv, path) { send('viewFileDiff', { env, nextEnv, path }); }

  function closeDiff() { document.getElementById('diffModal').style.display = 'none'; }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.command === 'fileDiffResult') {
      document.getElementById('diffTitle').textContent = msg.path;
      document.getElementById('beforePre').textContent = msg.before;
      document.getElementById('afterPre').textContent = msg.after;
      document.getElementById('diffModal').style.display = 'flex';
    }
  });
</script>
</body>
</html>`;
    }

    private _renderEnvSection(m: EnvViewModel): string {
        const env = m.env;
        const shortSha = (s: string | null) => s ? s.slice(0, 7) : "—";

        const lastDeployText = m.lastDeploy
            ? `Last deployed <code>${shortSha(m.lastDeploy.sha)}</code> on ${new Date(m.lastDeploy.deployedAt).toLocaleString()}`
            : `Never deployed from this dashboard`;

        const groupsHtml = m.groups.map(g => `
      <div class="group">
        <label class="group-head">
          <input type="checkbox" class="group-check" data-env="${env.name}" value="${escapeHtml(g.storyId)}">
          ${escapeHtml(g.storyId)}
          ${g.sharedWith.length ? `<span class="shared">shares file(s) with: ${g.sharedWith.map(escapeHtml).join(", ")}</span>` : ""}
        </label>
        <ul class="files">
          ${g.files.map(f => `<li><span class="change ${f.change}">${f.change}</span>${escapeHtml(f.path)}</li>`).join("")}
        </ul>
      </div>`).join("");

        const flatFilesHtml = `<ul class="files">${m.allFiles.map(f => `
      <li><label><input type="checkbox" class="file-check" data-env="${env.name}" value="${escapeHtml(f.path)}"> <span class="change ${f.change}">${f.change}</span>${escapeHtml(f.path)}</label></li>
    `).join("")}</ul>`;

        const noticeIfNoOrg = m.orgAliasSet ? "" : `<div class="warn">⚠ No org alias set for ${escapeHtml(env.label)} — set sfDevops.environments[].orgAlias to enable deploy/validate here.</div>`;
        const noticeIfNoRole = m.canDeploy ? "" : `<div class="warn">⚠ Your role can't deploy to ${escapeHtml(env.label)} (requires "${escapeHtml(env.requiredRole ?? "")}").</div>`;
        const disabled = (!m.orgAliasSet || !m.canDeploy) ? "disabled" : "";

        const diffBlock = m.nextEnv
            ? `<details class="diff">
          <summary>Preview diff: ${escapeHtml(env.label)} vs ${escapeHtml(m.nextEnv.label)} (${m.diffVsNext?.length ?? 0} file(s) different)</summary>
          <ul class="files">
            ${(m.diffVsNext ?? []).map(f => `<li onclick="viewFileDiff('${env.name}','${m.nextEnv!.branch}','${escapeHtml(f.path)}')"><span class="change ${f.change}">${f.change}</span>${escapeHtml(f.path)}</li>`).join("")}
          </ul>
        </details>`
            : "";

        const manifestBlock = m.allFiles.length
            ? `<details class="diff"><summary>package.xml preview (${m.allFiles.length} file(s))</summary><pre class="manifest">${escapeHtml(m.packageXml)}</pre>${m.unmapped.length ? `<div class="warn">Not in manifest: ${m.unmapped.map(escapeHtml).join(", ")}</div>` : ""}</details>`
            : "";

        return `
<section class="env">
  <h2>${escapeHtml(env.label)} <span class="meta">(${escapeHtml(env.branch)} → ${escapeHtml(env.orgAlias || "no org alias")})</span></h2>
  <div class="meta">${lastDeployText}</div>
  ${noticeIfNoOrg}${noticeIfNoRole}

  <div class="mode-row">
    <button class="mode-btn active" data-env="${env.name}" data-mode="all" onclick="setMode('${env.name}','all')">ALL (${m.allFiles.length})</button>
    <button class="mode-btn" data-env="${env.name}" data-mode="stories" onclick="setMode('${env.name}','stories')">By story/PR (${m.groups.length})</button>
    <button class="mode-btn" data-env="${env.name}" data-mode="files" onclick="setMode('${env.name}','files')">By file</button>
  </div>

  <div class="picker" data-for="stories" style="display:none">${groupsHtml || '<div class="meta">No pending changes.</div>'}</div>
  <div class="picker" data-for="files" style="display:none">${flatFilesHtml}</div>

  <div class="actions">
    <button class="btn btn-secondary" ${disabled} onclick="runAction('${env.name}','validate')">🔍 Validate selection</button>
    <button class="btn btn-primary" ${disabled} onclick="runAction('${env.name}','deploy')">🚀 Deploy selection</button>
  </div>

  ${diffBlock}
  ${manifestBlock}
</section>`;
    }
}

function dedupe(files: AuditChangedFile[]): AuditChangedFile[] {
    const seen = new Map<string, AuditChangedFile>();
    for (const f of files) { seen.set(f.path, f); }
    return Array.from(seen.values());
}
