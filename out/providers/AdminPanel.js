"use strict";
// AdminPanel.ts — Full-screen Admin / Setup panel.
// Centralises all setup checks, org alias management, role controls, and audit
// trail housekeeping in one place so the sidebar toolbar stays uncluttered.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.AdminPanel = void 0;
const vscode = __importStar(require("vscode"));
const SetupCheck_1 = require("../SetupCheck");
const config_1 = require("../config");
const RoleManager_1 = require("../RoleManager");
const RoleManager_2 = require("../RoleManager");
const shared_1 = require("../ui/shared");
class AdminPanel {
    static createOrShow(gitHelper, bbClient, context) {
        if (AdminPanel._current) {
            AdminPanel._current._panel.reveal(vscode.ViewColumn.Two);
            AdminPanel._current._refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel("sfDevopsAdmin", "Salesforce-DevOps — Admin / Setup", vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
        AdminPanel._current = new AdminPanel(panel, gitHelper, bbClient, context);
    }
    constructor(_panel, _git, _bb, _ctx) {
        this._panel = _panel;
        this._git = _git;
        this._bb = _bb;
        this._ctx = _ctx;
        this._disposables = [];
        this._refreshing = false;
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case "refresh":
                    await this._refresh();
                    break;
                case "recheck":
                    await this._refresh();
                    break;
                case "setOrgAlias":
                    await this._setOrgAlias(msg.key, msg.alias);
                    break;
                case "changeRole":
                    await vscode.commands.executeCommand("sfDevops.changeRole");
                    break;
                case "resetPwd":
                    await vscode.commands.executeCommand("sfDevops.resetRolePassword");
                    break;
                case "resetPwdForce":
                    await vscode.commands.executeCommand("sfDevops.resetRolePasswordForce");
                    break;
                case "openSettings":
                    await vscode.commands.executeCommand("sfDevops.openSettings");
                    break;
                case "viewAudit":
                    await vscode.commands.executeCommand("sfDevops.viewAuditLog");
                    break;
                case "trimAudit":
                    await this._trimAudit(msg.days);
                    break;
                case "clearAudit":
                    await this._clearAudit();
                    break;
                case "saveEnvironments":
                    await this._saveEnvironments(msg.envs);
                    break;
                case "saveBaseBranch":
                    await this._saveBaseBranch(msg.branch);
                    break;
                case "pushBranch":
                    await this._pushBranch(msg.branch);
                    break;
                case "createEnvBranch":
                    await this._createEnvBranch(msg.branch);
                    break;
                case "saveGuardrails":
                    await this._saveGuardrails(msg.threshold, msg.timeout);
                    break;
                case "saveRepoIdentity":
                    await this._saveRepoIdentity(msg.provider, msg.workspace, msg.slug);
                    break;
                case "openTerminal":
                    vscode.window.createTerminal("Salesforce-DevOps").show();
                    break;
            }
        }, null, this._disposables);
        this._panel.webview.html = this._loadingHtml();
        this._refresh();
    }
    _dispose() {
        AdminPanel._current = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }
    async _saveBaseBranch(branch) {
        const role = (0, RoleManager_2.getEffectiveRole)(this._ctx);
        if (!(0, RoleManager_1.canAccessConfig)(role)) {
            return;
        }
        try {
            await (0, config_1.saveBaseBranch)(branch.trim());
            vscode.window.showInformationMessage(`Default branch set to "${branch.trim() || "main"}".`);
            await this._refresh();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Could not save default branch: ${err}`);
        }
    }
    async _pushBranch(branch) {
        const role = (0, RoleManager_2.getEffectiveRole)(this._ctx);
        if (!(0, RoleManager_1.canAccessConfig)(role)) {
            return;
        }
        try {
            await this._git.pushLocalBranchToOrigin(branch);
            vscode.window.showInformationMessage(`Pushed "${branch}" to origin.`);
            await this._refresh();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Could not push "${branch}" to origin: ${err}`);
        }
    }
    async _createEnvBranch(branch) {
        const role = (0, RoleManager_2.getEffectiveRole)(this._ctx);
        if (!(0, RoleManager_1.canAccessConfig)(role)) {
            return;
        }
        try {
            await this._git.createEnvBranchOnOrigin(branch);
            vscode.window.showInformationMessage(`Created "${branch}" on origin from base branch.`);
            await this._refresh();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Could not create "${branch}" on origin: ${err}`);
        }
    }
    async _saveGuardrails(threshold, timeout) {
        const role = (0, RoleManager_2.getEffectiveRole)(this._ctx);
        if (!(0, RoleManager_1.canAccessConfig)(role)) {
            return;
        }
        try {
            if (Number.isFinite(threshold) && threshold > 0 && threshold <= 100) {
                await (0, config_1.saveCoverageThreshold)(threshold);
            }
            if (Number.isFinite(timeout) && timeout >= 30) {
                await (0, config_1.saveCoverageTimeoutSeconds)(timeout);
            }
            vscode.window.showInformationMessage("Guardrails saved.");
            await this._refresh();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Could not save guardrails: ${err}`);
        }
    }
    async _saveRepoIdentity(provider, workspace, slug) {
        const role = (0, RoleManager_2.getEffectiveRole)(this._ctx);
        if (!(0, RoleManager_1.canAccessConfig)(role)) {
            return;
        }
        try {
            await (0, config_1.saveRepoIdentity)(provider, workspace, slug);
            vscode.window.showInformationMessage("Repo identity saved.");
            await this._refresh();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Could not save repo identity: ${err}`);
        }
    }
    async _saveEnvironments(envs) {
        const role = (0, RoleManager_2.getEffectiveRole)(this._ctx);
        if (!(0, RoleManager_1.canAccessConfig)(role)) {
            return;
        }
        try {
            await (0, config_1.saveEnvironments)(envs);
            vscode.window.showInformationMessage("Pipeline branch configuration saved.");
            await this._refresh();
        }
        catch (err) {
            vscode.window.showErrorMessage(`Could not save environments: ${err}`);
        }
    }
    async _refresh() {
        if (this._refreshing) {
            return;
        }
        this._refreshing = true;
        try {
            const role = (0, RoleManager_2.getEffectiveRole)(this._ctx);
            const checks = await (0, SetupCheck_1.runSetupChecks)(this._git, this._bb, this._ctx, role);
            const slots = (0, config_1.getOrgAliasSlots)();
            const envs = (0, config_1.getEnvironments)();
            const baseBranch = (0, config_1.getBaseBranch)();
            const sizeKb = Math.round(await this._git.getAuditLogSizeBytes() / 1024);
            const retentionDays = (0, config_1.getAuditLogRetentionDays)();
            const coverageThreshold = (0, config_1.getCoverageThreshold)();
            const coverageTimeout = (0, config_1.getCoverageTimeoutSeconds)();
            const gitProvider = (0, config_1.getGitProvider)();
            const repoWorkspace = (0, config_1.getRepoWorkspace)();
            const repoSlug = (0, config_1.getRepoSlug)();
            this._panel.webview.html = this._renderHtml(checks, slots, envs, baseBranch, role, sizeKb, retentionDays, coverageThreshold, coverageTimeout, gitProvider, repoWorkspace, repoSlug);
        }
        catch (err) {
            this._panel.webview.html = `<body style="padding:20px;font-family:sans-serif;color:#f48771">Error: ${String(err)}</body>`;
        }
        finally {
            this._refreshing = false;
        }
    }
    async _setOrgAlias(key, alias) {
        const role = (0, RoleManager_2.getEffectiveRole)(this._ctx);
        if (!(0, RoleManager_1.canAccessConfig)(role)) {
            return;
        }
        await (0, config_1.setOrgAliasSlot)(key, alias.trim());
        await this._refresh();
    }
    async _trimAudit(days) {
        const confirm = await vscode.window.showWarningMessage(`Delete audit entries older than ${days} day${days === 1 ? "" : "s"}?`, { modal: true }, "Yes, delete");
        if (confirm !== "Yes, delete") {
            return;
        }
        const removed = await this._git.trimAuditLog(days * 24 * 60 * 60 * 1000);
        vscode.window.showInformationMessage(`Removed ${removed} audit entr${removed === 1 ? "y" : "ies"}.`);
        await this._refresh();
    }
    async _clearAudit() {
        const confirm = await vscode.window.showWarningMessage("Clear the ENTIRE audit log? This cannot be undone.", { modal: true }, "Yes, clear all");
        if (confirm !== "Yes, clear all") {
            return;
        }
        await this._git.trimAuditLog(0);
        vscode.window.showInformationMessage("Audit log cleared.");
        await this._refresh();
    }
    _loadingHtml() {
        return (0, shared_1.loadingHtml)("Checking setup…");
    }
    _renderHtml(checks, slots, envs, baseBranch, role, auditSizeKb, retentionDays, coverageThreshold, coverageTimeout, gitProvider, repoWorkspace, repoSlug) {
        const isAdmin = (0, RoleManager_1.canAccessConfig)(role);
        const failing = checks.filter(c => c.required && !c.passed).length;
        // Serialize environments for the webview (strip resolved-only fields; keep editable ones)
        const envData = JSON.stringify(envs.map(e => ({
            name: e.name,
            label: e.label,
            branch: e.branch,
            requiredRole: e.requiredRole ?? "",
            deployTestLevel: e.deployTestLevel,
            coverageGate: e.coverageGate,
            signoffGate: e.signoffGate,
            isProd: e.isProd,
            locked: e.locked,
        }))).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
        const statusBanner = failing > 0
            ? `<div class="banner warn">⚠ ${failing} required check(s) failing — fix them below.</div>`
            : `<div class="banner ok">✅ All required checks pass.</div>`;
        const checkRows = checks.map(c => {
            const icon = c.passed ? "✅" : (c.required ? "❌" : "⚠️");
            const cls = c.passed ? "pass" : (c.required ? "fail" : "warn");
            const fixHtml = !c.passed && c.fixSteps.length
                ? `<ol class="fix">${c.fixSteps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>` : "";
            let quickActionHtml = "";
            if (!c.passed && isAdmin) {
                if (c.key === "baseBranch") {
                    quickActionHtml = `<div style="margin:6px 0 0 24px;display:flex;align-items:center;gap:8px">
  <button class="btn btn-sm" onclick='pushBranch(${JSON.stringify(baseBranch)}, this)'>⬆ Push "${escapeHtml(baseBranch)}" to origin</button>
  <span class="branch-status" style="font-size:11px;color:var(--vscode-descriptionForeground);display:none"></span>
</div>`;
                }
                else if (c.key === "environmentBranches" && c.missingEnvBranches?.length) {
                    const btns = c.missingEnvBranches.map(m => `<button class="btn btn-sm" onclick='createEnvBranch(${JSON.stringify(m.branch)}, this)'>+ ${escapeHtml(m.label)} (${escapeHtml(m.branch)})</button>`).join(" ");
                    quickActionHtml = `<div style="margin:6px 0 0 24px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
  <span style="font-size:11px;color:var(--vscode-descriptionForeground)">Create on origin from base branch:</span>${btns}
</div>`;
                }
            }
            return `<div class="check ${cls}">
  <div class="check-head">${icon} <strong>${escapeHtml(c.label)}</strong>${c.required ? "" : " <span class='opt'>optional</span>"}</div>
  <div class="check-detail">${escapeHtml(c.detail)}</div>
  ${fixHtml}${quickActionHtml}
</div>`;
        }).join("");
        const slotRows = slots.map(s => `
<div class="slot-row">
  <span class="slot-label">${escapeHtml(s.label)}</span>
  ${isAdmin
            ? `<input id="alias-${escapeHtml(s.key)}" class="slot-input" type="text" value="${escapeHtml(s.alias ?? "")}" placeholder="e.g. myorg-dev">
       <button class="btn btn-sm" onclick="saveAlias('${escapeHtml(s.key)}')">Save</button>`
            : `<span class="slot-val">${escapeHtml(s.alias ?? "(not set)")}</span>`}
</div>`).join("");
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${(0, shared_1.cspMeta)(this._panel.webview)}
<style>
${(0, shared_1.sharedCss)()}
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
.et-id { font-size: 11px; padding: 2px 6px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 3px; background: var(--vscode-input-background); color: var(--vscode-descriptionForeground); width: 100%; min-width: 50px; margin-top: 3px; }
.default-branch-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
.default-branch-row label { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.default-branch-row input { width: 160px; }
.collapsible-h2 { display: flex; align-items: center; gap: 6px; }
.collapsible-h2 span { font-size: 11px; transition: transform 0.15s; display: inline-block; }
.collapsible-h2.collapsed span { transform: rotate(-90deg); }
.guardrail-table { width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 10px; }
.guardrail-table th { text-align: left; padding: 5px 8px; font-size: 11px; color: var(--vscode-descriptionForeground); font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border); white-space: nowrap; }
.guardrail-table td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
.guardrail-table tr:last-child td { border-bottom: none; }
.guardrail-table tr:hover td { background: var(--vscode-list-hoverBackground); }
.gate-on  { color: var(--ok, #4caf50); font-weight: 600; }
.gate-off { color: var(--vscode-descriptionForeground); }
.guardrail-inputs { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.guardrail-inputs label { font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.guardrail-inputs input { width: 70px; }
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

<h2 class="collapsible-h2" onclick="toggleSection('setupChecks', this)" style="cursor:pointer;user-select:none">
  <span id="setupChecksArrow">▼</span> Setup Checks
</h2>
<div id="setupChecks">
${checkRows}
</div>

<h2>Org Aliases</h2>
<p style="font-size:12px;color:var(--muted);margin:0 0 8px">
  Map environment slots to Salesforce org aliases used by the CLI.
  ${isAdmin ? "" : "Only Admins can change org aliases."}
</p>
${slotRows}

<h2>Repo Identity</h2>
<p style="font-size:12px;color:var(--muted);margin:0 0 10px">
  The GitHub account and repo used to build PR and branch links. Overrides what's auto-derived from the <code>origin</code> remote URL.
  ${isAdmin ? "Changes save to <code>.vscode/settings.json</code>." : "<strong>Admin access required to edit.</strong>"}
</p>
${isAdmin ? `
<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end;margin-bottom:8px">
  <div>
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px">Git Provider</div>
    <select class="et-select" id="repoProvider" style="font-size:12px;padding:4px 6px">
      <option value="github"${gitProvider === "github" ? " selected" : ""}>GitHub</option>
      <option value="bitbucket"${gitProvider === "bitbucket" ? " selected" : ""}>Bitbucket</option>
    </select>
  </div>
  <div>
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px">Owner / Workspace</div>
    <input class="et-input" id="repoWorkspace" value="${escapeHtml(repoWorkspace)}" placeholder="e.g. brar-sahab" style="width:180px">
  </div>
  <div>
    <div style="font-size:11px;color:var(--vscode-descriptionForeground);margin-bottom:3px">Repo Name</div>
    <input class="et-input" id="repoSlug" value="${escapeHtml(repoSlug)}" placeholder="e.g. sfdc-devops" style="width:180px">
  </div>
  <div>
    <button class="btn btn-sm" onclick="saveRepoIdentity()">Save</button>
    <span id="repoIdentityMsg" style="font-size:11px;color:var(--ok);display:none;margin-left:6px">Saved ✓</span>
  </div>
</div>` : `
<div style="font-size:12px;display:flex;gap:16px;flex-wrap:wrap">
  <span><strong>Provider:</strong> ${escapeHtml(gitProvider)}</span>
  <span><strong>Owner:</strong> ${escapeHtml(repoWorkspace || "(derived from remote)")}</span>
  <span><strong>Repo:</strong> ${escapeHtml(repoSlug || "(derived from remote)")}</span>
</div>`}

<h2>Guardrails</h2>
<p style="font-size:12px;color:var(--muted);margin:0 0 10px">
  Per-environment gate settings live in the Pipeline table below. Configure the global coverage threshold here.
</p>
<div class="guardrail-inputs">
  <label>Coverage threshold:</label>
  ${isAdmin
            ? `<input class="et-input" id="guardrailThreshold" type="number" min="1" max="100" value="${coverageThreshold}" style="width:60px"> %`
            : `<strong>${coverageThreshold}%</strong>`}
  <label style="margin-left:10px">Apex test timeout:</label>
  ${isAdmin
            ? `<input class="et-input" id="guardrailTimeout" type="number" min="30" value="${coverageTimeout}" style="width:80px"> s`
            : `<strong>${coverageTimeout}s</strong>`}
  ${isAdmin ? `<button class="btn btn-sm" onclick="saveGuardrails()">Save</button>
  <span id="guardrailMsg" style="font-size:11px;color:var(--ok);display:none">Saved ✓</span>` : ""}
</div>
<table class="guardrail-table">
  <thead><tr>
    <th>Environment</th>
    <th title="Coverage check must pass before story can promote to this env">Coverage Gate</th>
    <th title="Human sign-off required before story can promote from this env">Sign-off Gate</th>
    <th>Required Role</th>
    <th title="Enables production safety guards (no auto-deploy, etc.)">Production</th>
    <th title="All promotions and deploys blocked for all roles">Locked</th>
  </tr></thead>
  <tbody>
    ${envs.map(e => `<tr>
      <td><strong>${escapeHtml(e.label)}</strong> <span style="font-size:10px;color:var(--vscode-descriptionForeground)">(${escapeHtml(e.branch)})</span></td>
      <td class="${e.coverageGate ? "gate-on" : "gate-off"}">${e.coverageGate ? `✅ ≥ ${coverageThreshold}%` : "—"}</td>
      <td class="${e.signoffGate ? "gate-on" : "gate-off"}">${e.signoffGate ? "✅ Required" : "—"}</td>
      <td>${escapeHtml(e.requiredRole ?? "Any")}</td>
      <td>${e.isProd ? "🏭 Yes" : "—"}</td>
      <td class="${e.locked ? "gate-on" : "gate-off"}">${e.locked ? "🔒 Locked" : "—"}</td>
    </tr>`).join("")}
  </tbody>
</table>

<h2>Pipeline / Branch Setup</h2>
<p style="font-size:12px;color:var(--muted);margin:0 0 10px">
  Define the promotion pipeline in order. New stories are cut from the <strong>Default Branch</strong>; the first stage is where feature branches publish directly; all later stages require a promotion PR.
  ${isAdmin ? "Changes save to <code>.vscode/settings.json</code>." : "<strong>Admin access required to edit.</strong>"}
</p>
<div class="default-branch-row">
  <label>Default branch (new stories cut from):</label>
  ${isAdmin
            ? `<input class="et-input" id="defaultBranchInput" value="${escapeHtml(baseBranch)}" placeholder="main" style="width:160px">
       <button class="btn btn-sm" onclick="saveDefaultBranch()">Save</button>
       <span id="defaultBranchMsg" style="font-size:11px;color:var(--ok);display:none">Saved ✓</span>`
            : `<code>${escapeHtml(baseBranch)}</code>`}
</div>
${isAdmin ? `
<table class="env-table" id="envTable">
  <thead><tr>
    <th style="width:44px"></th>
    <th>Name</th>
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
  <thead><tr><th>Name</th><th>Branch</th><th>Required Role</th><th>Test Level</th><th>Gates</th><th>Flags</th></tr></thead>
  <tbody>${envs.map(e => `<tr>
    <td><span style="font-size:12px">${escapeHtml(e.label)}</span><br><span style="font-size:10px;color:var(--vscode-descriptionForeground)">${escapeHtml(e.name)}</span></td>
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

<script type="application/json" id="__sfdo-env-data__">${envData}</script>
<script>
  const vscode = acquireVsCodeApi();
  function send(cmd, arg) { vscode.postMessage({ command: cmd, days: typeof arg === 'number' ? arg : undefined }); }
  function saveAlias(key) {
    var val = document.getElementById('alias-' + key).value;
    vscode.postMessage({ command: 'setOrgAlias', key: key, alias: val });
  }
  function pushBranch(branch, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Pushing…'; }
    var status = btn && btn.parentElement && btn.parentElement.querySelector('.branch-status');
    if (status) { status.textContent = 'Pushing to origin…'; status.style.display = 'inline'; }
    vscode.postMessage({ command: 'pushBranch', branch: branch });
  }
  function createEnvBranch(branch, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Creating…'; }
    vscode.postMessage({ command: 'createEnvBranch', branch: branch });
  }
  function saveRepoIdentity() {
    var provider  = (document.getElementById('repoProvider')  || {}).value || '';
    var workspace = (document.getElementById('repoWorkspace') || {}).value || '';
    var slug      = (document.getElementById('repoSlug')      || {}).value || '';
    vscode.postMessage({ command: 'saveRepoIdentity', provider: provider, workspace: workspace, slug: slug });
    var msg = document.getElementById('repoIdentityMsg');
    if (msg) { msg.style.display = 'inline'; setTimeout(function() { msg.style.display = 'none'; }, 2500); }
  }
  function saveGuardrails() {
    var threshold = parseInt((document.getElementById('guardrailThreshold') || {}).value, 10);
    var timeout   = parseInt((document.getElementById('guardrailTimeout')   || {}).value, 10);
    vscode.postMessage({ command: 'saveGuardrails', threshold: threshold, timeout: timeout });
    var msg = document.getElementById('guardrailMsg');
    if (msg) { msg.style.display = 'inline'; setTimeout(function() { msg.style.display = 'none'; }, 2500); }
  }

  function toggleSection(id, header) {
    var el = document.getElementById(id);
    if (!el) { return; }
    var collapsed = el.style.display === 'none';
    el.style.display = collapsed ? '' : 'none';
    if (collapsed) { header.classList.remove('collapsed'); } else { header.classList.add('collapsed'); }
  }

  /* ── Pipeline / Branch editor ── */
  var envs = (function() {
    try { return JSON.parse(document.getElementById('__sfdo-env-data__').textContent).map(function(e) { return Object.assign({}, e); }); }
    catch(e) { return []; }
  })();

  var ROLES       = ['', 'Lead', 'Admin'];
  var TEST_LEVELS = ['RunLocalTests', 'RunAllTestsInOrg'];

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
      + '<td>'
      +   '<input class="et-input" data-field="label" data-row="' + i + '" value="' + hesc(e.label) + '" placeholder="DEV">'
      +   '<input class="et-id" data-field="name" data-row="' + i + '" value="' + hesc(e.name) + '" placeholder="dev">'
      + '</td>'
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

  function saveDefaultBranch() {
    var val = (document.getElementById('defaultBranchInput').value || '').trim() || 'main';
    vscode.postMessage({ command: 'saveBaseBranch', branch: val });
    var msg = document.getElementById('defaultBranchMsg');
    if (msg) { msg.style.display = 'inline'; setTimeout(function() { msg.style.display = 'none'; }, 2500); }
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
exports.AdminPanel = AdminPanel;
function escapeHtml(s) {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
}
//# sourceMappingURL=AdminPanel.js.map