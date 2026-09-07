// AdminPanel.ts — Full-screen Admin / Setup panel.
// Centralises all setup checks, org alias management, role controls, and audit
// trail housekeeping in one place so the sidebar toolbar stays uncluttered.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { IGitProviderClient } from "../GitProviderClient";
import { runSetupChecks, SetupCheckItem } from "../SetupCheck";
import { getOrgAliasSlots, setOrgAliasSlot, OrgAliasSlot, getAuditLogRetentionDays, getEnvironments, saveEnvironments, EnvironmentSetting } from "../config";
import { canAccessConfig } from "../RoleManager";
import { getEffectiveRole } from "../RoleManager";
import { sharedCss, cspMeta, loadingHtml } from "../ui/shared";

export class AdminPanel {
    private static _current: AdminPanel | undefined;
    private readonly _disposables: vscode.Disposable[] = [];
    private _refreshing = false;

    static createOrShow(
        gitHelper:  GitHelper,
        bbClient:   IGitProviderClient,
        context:    vscode.ExtensionContext,
    ): void {
        if (AdminPanel._current) {
            AdminPanel._current._panel.reveal(vscode.ViewColumn.Two);
            AdminPanel._current._refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsAdmin",
            "Salesforce-DevOps — Admin / Setup",
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        AdminPanel._current = new AdminPanel(panel, gitHelper, bbClient, context);
    }

    private constructor(
        private readonly _panel:   vscode.WebviewPanel,
        private readonly _git:     GitHelper,
        private readonly _bb:      IGitProviderClient,
        private readonly _ctx:     vscode.ExtensionContext,
    ) {
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case "refresh":      await this._refresh(); break;
                case "recheck":      await this._refresh(); break;
                case "setOrgAlias":  await this._setOrgAlias(msg.key, msg.alias); break;
                case "changeRole":   await vscode.commands.executeCommand("sfDevops.changeRole"); break;
                case "resetPwd":     await vscode.commands.executeCommand("sfDevops.resetRolePassword"); break;
                case "resetPwdForce": await vscode.commands.executeCommand("sfDevops.resetRolePasswordForce"); break;
                case "openSettings": await vscode.commands.executeCommand("sfDevops.openSettings"); break;
                case "viewAudit":    await vscode.commands.executeCommand("sfDevops.viewAuditLog"); break;
                case "trimAudit":       await this._trimAudit(msg.days); break;
                case "clearAudit":      await this._clearAudit(); break;
                case "saveEnvironments": await this._saveEnvironments(msg.envs); break;
                case "openTerminal":
                    vscode.window.createTerminal("Salesforce-DevOps").show();
                    break;
            }
        }, null, this._disposables);
        this._panel.webview.html = this._loadingHtml();
        this._refresh();
    }

    private _dispose(): void {
        AdminPanel._current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    private async _saveEnvironments(envs: EnvironmentSetting[]): Promise<void> {
        try {
            await saveEnvironments(envs);
            vscode.window.showInformationMessage("Pipeline branch configuration saved.");
            await this._refresh();
        } catch (err) {
            vscode.window.showErrorMessage(`Could not save environments: ${err}`);
        }
    }

    private async _refresh(): Promise<void> {
        if (this._refreshing) { return; }
        this._refreshing = true;
        try {
            const role   = getEffectiveRole(this._ctx);
            const checks = await runSetupChecks(this._git, this._bb, this._ctx, role);
            const slots  = getOrgAliasSlots();
            const envs   = getEnvironments();
            const sizeKb = Math.round(await this._git.getAuditLogSizeBytes() / 1024);
            const retentionDays = getAuditLogRetentionDays();
            this._panel.webview.html = this._renderHtml(checks, slots, envs, role, sizeKb, retentionDays);
        } catch (err) {
            this._panel.webview.html = `<body style="padding:20px;font-family:sans-serif;color:#f48771">Error: ${String(err)}</body>`;
        } finally {
            this._refreshing = false;
        }
    }

    private async _setOrgAlias(key: string, alias: string): Promise<void> {
        await setOrgAliasSlot(key, alias.trim());
        await this._refresh();
    }

    private async _trimAudit(days: number): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete audit entries older than ${days} day${days === 1 ? "" : "s"}?`,
            { modal: true }, "Yes, delete"
        );
        if (confirm !== "Yes, delete") { return; }
        const removed = await this._git.trimAuditLog(days * 24 * 60 * 60 * 1000);
        vscode.window.showInformationMessage(`Removed ${removed} audit entr${removed === 1 ? "y" : "ies"}.`);
        await this._refresh();
    }

    private async _clearAudit(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            "Clear the ENTIRE audit log? This cannot be undone.",
            { modal: true }, "Yes, clear all"
        );
        if (confirm !== "Yes, clear all") { return; }
        await this._git.trimAuditLog(0);
        vscode.window.showInformationMessage("Audit log cleared.");
        await this._refresh();
    }

    private _loadingHtml(): string {
        return loadingHtml("Checking setup…");
    }

    private _renderHtml(
        checks:        SetupCheckItem[],
        slots:         OrgAliasSlot[],
        envs:          ReturnType<typeof getEnvironments>,
        role:          string,
        auditSizeKb:   number,
        retentionDays: number,
    ): string {
        const isAdmin  = canAccessConfig(role);
        const failing  = checks.filter(c => c.required && !c.passed).length;

        // Serialize environments for the webview (strip resolved-only fields; keep editable ones)
        const envData = JSON.stringify(envs.map(e => ({
            name:            e.name,
            label:           e.label,
            branch:          e.branch,
            requiredRole:    e.requiredRole ?? "",
            deployTestLevel: e.deployTestLevel,
            coverageGate:    e.coverageGate,
            signoffGate:     e.signoffGate,
            isProd:          e.isProd,
            locked:          e.locked,
        }))).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
        const statusBanner = failing > 0
            ? `<div class="banner warn">⚠ ${failing} required check(s) failing — fix them below.</div>`
            : `<div class="banner ok">✅ All required checks pass.</div>`;

        const checkRows = checks.map(c => {
            const icon    = c.passed ? "✅" : (c.required ? "❌" : "⚠️");
            const cls     = c.passed ? "pass" : (c.required ? "fail" : "warn");
            const fixHtml = !c.passed && c.fixSteps.length
                ? `<ol class="fix">${c.fixSteps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>` : "";
            return `<div class="check ${cls}">
  <div class="check-head">${icon} <strong>${escapeHtml(c.label)}</strong>${c.required ? "" : " <span class='opt'>optional</span>"}</div>
  <div class="check-detail">${escapeHtml(c.detail)}</div>
  ${fixHtml}
</div>`;
        }).join("");

        const slotRows = slots.map(s => `
<div class="slot-row">
  <span class="slot-label">${escapeHtml(s.label)}</span>
  ${isAdmin
    ? `<input id="alias-${escapeHtml(s.key)}" class="slot-input" type="text" value="${escapeHtml(s.alias ?? "")}" placeholder="e.g. myorg-dev">
       <button class="btn btn-sm" onclick="saveAlias('${escapeHtml(s.key)}')">Save</button>`
    : `<span class="slot-val">${escapeHtml(s.alias ?? "(not set)")}</span>`
  }
</div>`).join("");

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${cspMeta(this._panel.webview)}
<style>
${sharedCss()}
.slot-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.slot-label { font-size: 12px; width: 90px; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
.slot-input { width: 240px; }
.slot-val { font-size: 12px; }
.role-box { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 10px 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.role-name { font-weight: 600; font-size: 14px; }
.audit-box { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 10px 14px; }
.audit-meta { font-size: 12px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
.trim-row { display: flex; gap: 6px; flex-wrap: wrap; }
.env-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
.env-table th { text-align: left; padding: 5px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
.env-table td { padding: 5px 6px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
.env-table tr:last-child td { border-bottom: none; }
.env-table tr:hover td { background: var(--vscode-list-hoverBackground); }
.et-input { font-size: 12px; padding: 3px 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); width: 100%; min-width: 60px; }
.et-select { font-size: 12px; padding: 3px 4px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
.order-btn { font-size: 11px; padding: 1px 5px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; cursor: pointer; background: transparent; color: var(--vscode-foreground); }
.order-btn:hover { background: var(--vscode-list-hoverBackground); }
.del-btn { font-size: 11px; padding: 2px 6px; border: 1px solid var(--vscode-errorForeground, #f44747); border-radius: 3px; cursor: pointer; background: transparent; color: var(--vscode-errorForeground, #f44747); }
.env-actions { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; flex-wrap: wrap; }
.check { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 9px 12px; margin-bottom: 6px; }
.check.fail { border-color: var(--vscode-errorForeground, #f44747); }
.check.warn { border-color: var(--vscode-notificationsWarningIcon-foreground, #e6a817); }
.check-head { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.check-detail { font-size: 12px; color: var(--vscode-descriptionForeground); margin: 3px 0 0 24px; }
ol.fix { margin: 5px 0 0 24px; padding-left: 16px; font-size: 12px; color: var(--vscode-notificationsWarningIcon-foreground, #e6a817); }
.opt { font-size: 11px; font-weight: normal; color: var(--vscode-descriptionForeground); }
.cb-cell { display: flex; gap: 10px; align-items: center; }
.cb-label { font-size: 11px; color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 3px; white-space: nowrap; }
</style>
</head>
<body>
<h1>⚙ Admin / Setup</h1>

<div class="toolbar">
  <button class="btn" onclick="send('recheck')">↻ Re-check Setup</button>
  <button class="btn" onclick="send('openSettings')">⚙ Open Settings</button>
  <button class="btn" onclick="send('viewAudit')">📋 Full Audit Trail</button>
  <button class="btn" onclick="send('openTerminal')">$ Terminal</button>
</div>

${statusBanner}

<h2>Setup Checks</h2>
${checkRows}

<h2>Org Aliases</h2>
<p style="font-size:12px;color:var(--muted);margin:0 0 8px">
  Map environment slots to Salesforce org aliases used by the CLI.
  ${isAdmin ? "" : "Only Admins can change org aliases."}
</p>
${slotRows}

<h2>Pipeline / Branch Setup</h2>
<p style="font-size:12px;color:var(--muted);margin:0 0 10px">
  Define the promotion pipeline in order. The first stage is where feature branches publish directly; all later stages require a promotion PR.
  ${isAdmin ? "Changes save to <code>.vscode/settings.json</code>." : "<strong>Admin access required to edit.</strong>"}
</p>
${isAdmin ? `
<table class="env-table" id="envTable">
  <thead><tr>
    <th style="width:44px"></th>
    <th>Name <span style="font-weight:normal;color:var(--muted)">(ID)</span></th>
    <th>Label</th>
    <th>Branch</th>
    <th>Required Role</th>
    <th>Test Level</th>
    <th>Gates</th>
    <th>Flags</th>
    <th style="width:32px"></th>
  </tr></thead>
  <tbody id="envBody"></tbody>
</table>
<div class="env-actions">
  <button class="btn" onclick="addRow()">+ Add Stage</button>
  <button class="save-btn" onclick="saveEnvs()">💾 Save Pipeline</button>
  <span id="saveMsg" style="font-size:11px;color:var(--ok);display:none">Saved ✓</span>
</div>` : `
<table class="env-table">
  <thead><tr><th>Name</th><th>Label</th><th>Branch</th><th>Required Role</th><th>Test Level</th><th>Gates</th><th>Flags</th></tr></thead>
  <tbody>${envs.map(e => `<tr>
    <td>${escapeHtml(e.name)}</td>
    <td>${escapeHtml(e.label)}</td>
    <td><code>${escapeHtml(e.branch)}</code></td>
    <td>${escapeHtml(e.requiredRole ?? "Any")}</td>
    <td style="font-size:11px">${escapeHtml(e.deployTestLevel)}</td>
    <td style="font-size:11px">${[e.coverageGate && "Coverage", e.signoffGate && "Sign-off"].filter(Boolean).join(", ") || "—"}</td>
    <td style="font-size:11px">${[e.isProd && "Production", e.locked && "Locked"].filter(Boolean).join(", ") || "—"}</td>
  </tr>`).join("")}
  </tbody>
</table>`}

<h2>Role</h2>
<div class="role-box">
  <span>Current role:</span>
  <span class="role-name">👤 ${escapeHtml(role)}</span>
  <button class="btn" onclick="send('changeRole')">Change Role…</button>
  ${isAdmin ? `<button class="btn" onclick="send('resetPwd')">Reset Role Password…</button>
  <button class="btn btn-danger" onclick="send('resetPwdForce')">⚡ Break-Glass Reset…</button>` : ""}
</div>

<h2>Audit Trail</h2>
<div class="audit-box">
  <div class="audit-meta">Log size: <strong>${auditSizeKb > 0 ? auditSizeKb + " KB" : "empty"}</strong>
  ${retentionDays > 0 ? ` · Auto-trim after ${retentionDays} days` : " · No auto-trim configured"}</div>
  <div class="trim-row">
    <button class="btn" onclick="send('trimAudit', 7)">Delete older than 7 days</button>
    <button class="btn" onclick="send('trimAudit', 30)">Delete older than 30 days</button>
    <button class="btn" onclick="send('trimAudit', 90)">Delete older than 90 days</button>
    <button class="btn btn-danger" onclick="send('clearAudit')">Clear all</button>
  </div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  function send(cmd, arg) { vscode.postMessage({ command: cmd, days: typeof arg === 'number' ? arg : undefined }); }
  function saveAlias(key) {
    var val = document.getElementById('alias-' + key).value;
    vscode.postMessage({ command: 'setOrgAlias', key: key, alias: val });
  }

  /* ── Pipeline / Branch editor ── */
  var envs = (function() {
    try { return JSON.parse('${envData}').map(function(e) { return Object.assign({}, e); }); }
    catch(e) { return []; }
  })();

  var ROLES       = ['', 'Lead', 'Admin'];
  var TEST_LEVELS = ['RunLocalTests', 'RunAllTestsInOrg', 'RunSpecifiedTests'];

  function hesc(s) {
    return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function rowHtml(e, i, total) {
    var upDis  = i === 0 ? ' disabled style="opacity:0.25"' : '';
    var dnDis  = i === total-1 ? ' disabled style="opacity:0.25"' : '';
    var roleOpts = ROLES.map(function(r) {
      return '<option value="' + hesc(r) + '"' + (e.requiredRole === r ? ' selected' : '') + '>' + hesc(r || 'Any') + '</option>';
    }).join('');
    var testOpts = TEST_LEVELS.map(function(t) {
      return '<option value="' + hesc(t) + '"' + (e.deployTestLevel === t ? ' selected' : '') + '>' + hesc(t) + '</option>';
    }).join('');
    return '<tr data-row="' + i + '">'
      + '<td style="white-space:nowrap">'
      +   '<button class="order-btn" data-action="up" data-row="' + i + '"' + upDis + ' title="Move up">▲</button> '
      +   '<button class="order-btn" data-action="dn" data-row="' + i + '"' + dnDis + ' title="Move down">▼</button>'
      + '</td>'
      + '<td><input class="et-input" data-field="name" data-row="' + i + '" value="' + hesc(e.name) + '" placeholder="dev"></td>'
      + '<td><input class="et-input" data-field="label" data-row="' + i + '" value="' + hesc(e.label) + '" placeholder="DEV"></td>'
      + '<td><input class="et-input" data-field="branch" data-row="' + i + '" value="' + hesc(e.branch) + '" placeholder="dev"></td>'
      + '<td><select class="et-select" data-field="requiredRole" data-row="' + i + '">' + roleOpts + '</select></td>'
      + '<td><select class="et-select" data-field="deployTestLevel" data-row="' + i + '">' + testOpts + '</select></td>'
      + '<td><span class="cb-cell">'
      +   '<label class="cb-label"><input type="checkbox" data-field="coverageGate" data-row="' + i + '"' + (e.coverageGate ? ' checked' : '') + '> Coverage</label> '
      +   '<label class="cb-label"><input type="checkbox" data-field="signoffGate" data-row="' + i + '"' + (e.signoffGate ? ' checked' : '') + '> Sign-off</label>'
      + '</span></td>'
      + '<td><span class="cb-cell">'
      +   '<label class="cb-label"><input type="checkbox" data-field="isProd" data-row="' + i + '"' + (e.isProd ? ' checked' : '') + '> Prod</label> '
      +   '<label class="cb-label"><input type="checkbox" data-field="locked" data-row="' + i + '"' + (e.locked ? ' checked' : '') + '> Locked</label>'
      + '</span></td>'
      + '<td><button class="del-btn" data-action="del" data-row="' + i + '" title="Remove stage">✕</button></td>'
      + '</tr>';
  }

  function renderTable() {
    var body = document.getElementById('envBody');
    if (!body) { return; }
    body.innerHTML = envs.map(function(e, i) { return rowHtml(e, i, envs.length); }).join('');
  }

  /* Event delegation — one listener on the tbody handles all rows */
  document.addEventListener('DOMContentLoaded', function() {
    var body = document.getElementById('envBody');
    if (!body) { return; }
    renderTable();

    body.addEventListener('input', function(ev) {
      var el = ev.target;
      var row = parseInt(el.getAttribute('data-row'), 10);
      var field = el.getAttribute('data-field');
      if (isNaN(row) || !field || !envs[row]) { return; }
      envs[row][field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    body.addEventListener('change', function(ev) {
      var el = ev.target;
      var row = parseInt(el.getAttribute('data-row'), 10);
      var field = el.getAttribute('data-field');
      if (isNaN(row) || !field || !envs[row]) { return; }
      envs[row][field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    body.addEventListener('click', function(ev) {
      var el = ev.target.closest('[data-action]');
      if (!el) { return; }
      var action = el.getAttribute('data-action');
      var row = parseInt(el.getAttribute('data-row'), 10);
      if (action === 'up' && row > 0) {
        var tmp = envs[row]; envs[row] = envs[row-1]; envs[row-1] = tmp;
        renderTable();
      } else if (action === 'dn' && row < envs.length-1) {
        var tmp = envs[row]; envs[row] = envs[row+1]; envs[row+1] = tmp;
        renderTable();
      } else if (action === 'del') {
        if (envs.length <= 1) { return; }
        envs.splice(row, 1);
        renderTable();
      }
    });
  });

  function addRow() {
    envs.push({ name: '', label: '', branch: '', requiredRole: '', deployTestLevel: 'RunLocalTests', coverageGate: false, signoffGate: false, isProd: false, locked: false });
    renderTable();
    var body = document.getElementById('envBody');
    if (body && body.lastElementChild) {
      body.lastElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  function saveEnvs() {
    for (var i = 0; i < envs.length; i++) {
      if (!String(envs[i].name || '').trim()) { alert('Stage ' + (i+1) + ' is missing a Name.'); return; }
      if (!String(envs[i].branch || '').trim()) { alert('Stage "' + envs[i].name + '" is missing a Branch name.'); return; }
    }
    var toSave = envs.map(function(e) {
      return Object.assign({}, e, {
        name:   String(e.name || '').trim(),
        branch: String(e.branch || '').trim(),
        label:  String(e.label || '').trim() || String(e.name || '').trim().toUpperCase()
      });
    });
    vscode.postMessage({ command: 'saveEnvironments', envs: toSave });
    var msg = document.getElementById('saveMsg');
    if (msg) { msg.style.display = 'inline'; setTimeout(function() { msg.style.display = 'none'; }, 2500); }
  }
</script>
</body>
</html>`;
    }
}

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
}
