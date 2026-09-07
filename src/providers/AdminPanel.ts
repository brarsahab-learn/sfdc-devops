// AdminPanel.ts — Full-screen Admin / Setup panel.
// Centralises all setup checks, org alias management, role controls, and audit
// trail housekeeping in one place so the sidebar toolbar stays uncluttered.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { IGitProviderClient } from "../GitProviderClient";
import { runSetupChecks, SetupCheckItem } from "../SetupCheck";
import { getOrgAliasSlots, setOrgAliasSlot, OrgAliasSlot, getAuditLogRetentionDays } from "../config";
import { canAccessConfig } from "../RoleManager";
import { getEffectiveRole } from "../RoleManager";

export class AdminPanel {
    private static _current: AdminPanel | undefined;
    private readonly _disposables: vscode.Disposable[] = [];

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
                case "trimAudit":    await this._trimAudit(msg.days); break;
                case "clearAudit":   await this._clearAudit(); break;
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

    private async _refresh(): Promise<void> {
        try {
            const role   = getEffectiveRole(this._ctx);
            const checks = await runSetupChecks(this._git, this._bb, this._ctx, role);
            const slots  = getOrgAliasSlots();
            const sizeKb = Math.round(await this._git.getAuditLogSizeBytes() / 1024);
            const retentionDays = getAuditLogRetentionDays();
            this._panel.webview.html = this._renderHtml(checks, slots, role, sizeKb, retentionDays);
        } catch (err) {
            this._panel.webview.html = `<body style="padding:20px;font-family:sans-serif;color:#f48771">Error: ${String(err)}</body>`;
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
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Loading…</body></html>`;
    }

    private _renderHtml(
        checks:        SetupCheckItem[],
        slots:         OrgAliasSlot[],
        role:          string,
        auditSizeKb:   number,
        retentionDays: number,
    ): string {
        const isAdmin  = canAccessConfig(role);
        const failing  = checks.filter(c => c.required && !c.passed).length;
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
<style>
  :root { --bg:#1e1e1e; --fg:#e0e0e0; --card:#252526; --border:#3c3c3c; --muted:#888; --accent:#4fc3f7; --ok:#7cd992; --warn:#ffab70; --err:#ff6b6b; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fff; --fg:#1a1a1a; --card:#f5f5f5; --border:#ddd; --muted:#666; --accent:#0078d4; --ok:#1b6b2f; --warn:#a05000; --err:#c62828; }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 20px 28px 60px; max-width: 900px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 14px; margin: 24px 0 8px; border-bottom: 1px solid var(--border); padding-bottom: 4px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .toolbar { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .btn { font-size: 12px; padding: 5px 13px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--fg); }
  .btn:hover { background: var(--card); }
  .btn-sm { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--fg); }
  .btn-danger { border-color: var(--err); color: var(--err); }
  .btn-primary { background: #0078d4; color: #fff; border-color: #0078d4; }

  .banner { border-radius: 6px; padding: 8px 12px; margin-bottom: 12px; font-size: 13px; }
  .banner.ok   { background: color-mix(in srgb, var(--ok) 12%, var(--bg));   border: 1px solid var(--ok);   color: var(--ok); }
  .banner.warn { background: color-mix(in srgb, var(--warn) 12%, var(--bg)); border: 1px solid var(--warn); color: var(--warn); }

  .check { border: 1px solid var(--border); border-radius: 6px; padding: 9px 12px; margin-bottom: 6px; }
  .check.fail { border-color: var(--err); }
  .check.warn { border-color: var(--warn); }
  .check-head { display: flex; align-items: center; gap: 6px; font-size: 13px; }
  .check-detail { font-size: 12px; color: var(--muted); margin: 3px 0 0 24px; }
  ol.fix { margin: 5px 0 0 24px; padding-left: 16px; font-size: 12px; color: var(--warn); }
  .opt { font-size: 11px; font-weight: normal; color: var(--muted); }

  .slot-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .slot-label { font-size: 12px; width: 80px; flex-shrink: 0; color: var(--muted); }
  .slot-input { font-size: 12px; padding: 4px 8px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); flex: 1; max-width: 280px; }
  .slot-val { font-size: 12px; color: var(--fg); }

  .role-box { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .role-name { font-weight: 600; font-size: 15px; }
  .audit-box { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; }
  .audit-meta { font-size: 12px; color: var(--muted); margin-bottom: 8px; }
  .trim-row { display: flex; gap: 6px; flex-wrap: wrap; }
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
</script>
</body>
</html>`;
    }
}

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
}
