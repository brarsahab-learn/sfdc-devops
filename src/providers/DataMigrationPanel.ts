// DataMigrationPanel.ts — 4-tab VS Code webview panel for Salesforce Data Migration.

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { sharedCss, cspMeta, loadingHtml } from "../ui/shared";
import { getEffectiveRole } from "../RoleManager";
import { getRoles, getEnvironments, getOrgAliasSlots } from "../config";
import {
    readDmConfig, writeDmConfig, getSourceOrg, getTargetOrg, setSourceOrg, setTargetOrg,
    DmConfig, DmObjectConfig, readTracking, lastRunLogPath, dmBaseDir
} from "../DataMigrationConfig";
import {
    makeController, pullData, loadData, rollbackData, autoSortByDependencies,
    checkExternalId, createExternalIdField, listAvailableOrgs,
    DmRunController, DmProgressEvent
} from "../DataMigrationEngine";
import { log } from "../Log";

// ── helpers ──────────────────────────────────────────────────────────────────

function esc(s: string): string {
    return String(s).replace(/[<>&"]/g, (c) => (({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" } as Record<string, string>)[c] ?? c));
}

function jsonInject(data: unknown): string {
    return JSON.stringify(data)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026");
}

// ── panel ────────────────────────────────────────────────────────────────────

export class DataMigrationPanel {
    private static _current: DataMigrationPanel | undefined;
    private readonly _disposables: vscode.Disposable[] = [];
    private _refreshing = false;

    private _config: DmConfig = { objects: [], autoCreateExternalId: true, batchSize: 190, seedDir: ".git/sf-devops-dm/seed" };
    private _activeTab: "config" | "run" | "tracking" | "extids" = "config";
    private _runController: DmRunController | undefined;
    private _runState: "idle" | "running" | "paused" | "done" = "idle";
    private _logLines: string[] = [];
    private _dryRunMode = false;
    private _availableOrgs: { alias: string; username: string }[] = [];

    // ── static entry point ───────────────────────────────────────────────────

    static createOrShow(context: vscode.ExtensionContext, workspaceRoot: string): void {
        // Role gate
        const role = getEffectiveRole(context);
        const roles = getRoles();
        const leadIdx = roles.findIndex((r) => r.toLowerCase() === "lead");
        const userIdx = roles.findIndex((r) => r === role);

        if (DataMigrationPanel._current) {
            DataMigrationPanel._current._panel.reveal(vscode.ViewColumn.Two);
            DataMigrationPanel._current._refresh();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            "sfDevopsDataMigration",
            "Salesforce-DevOps — Data Migration",
            vscode.ViewColumn.Two,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        if (userIdx < leadIdx) {
            panel.webview.html = DataMigrationPanel._accessDeniedHtml(panel.webview, role, roles[leadIdx] ?? "Lead");
            // Still wire up elevateRole so the button works
            const sub = panel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.command === "elevateRole") {
                    await vscode.commands.executeCommand("sfDevops.changeRole");
                    // Re-evaluate role and re-open
                    panel.dispose();
                    DataMigrationPanel.createOrShow(context, workspaceRoot);
                }
            });
            panel.onDidDispose(() => sub.dispose());
            return;
        }

        DataMigrationPanel._current = new DataMigrationPanel(panel, context, workspaceRoot);
    }

    private constructor(
        private readonly _panel: vscode.WebviewPanel,
        private readonly _ctx: vscode.ExtensionContext,
        private readonly _workspaceRoot: string
    ) {
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.command) {
                case "switchTab":
                    this._activeTab = msg.tab;
                    this._refresh();
                    break;

                case "refresh":
                    this._refresh();
                    break;

                case "saveConfig":
                    writeDmConfig(this._workspaceRoot, msg.config as DmConfig);
                    this._config = msg.config as DmConfig;
                    this._refresh();
                    break;

                case "addObject": {
                    const cfg = readDmConfig(this._workspaceRoot);
                    cfg.objects.push(msg.obj as DmObjectConfig);
                    writeDmConfig(this._workspaceRoot, cfg);
                    this._config = cfg;
                    this._refresh();
                    break;
                }

                case "updateObject": {
                    const cfg = readDmConfig(this._workspaceRoot);
                    const idx = cfg.objects.findIndex((o) => o.id === msg.obj.id);
                    if (idx !== -1) { cfg.objects[idx] = msg.obj as DmObjectConfig; }
                    writeDmConfig(this._workspaceRoot, cfg);
                    this._config = cfg;
                    this._refresh();
                    break;
                }

                case "deleteObject": {
                    const cfg = readDmConfig(this._workspaceRoot);
                    cfg.objects = cfg.objects.filter((o) => o.id !== msg.id);
                    writeDmConfig(this._workspaceRoot, cfg);
                    this._config = cfg;
                    this._refresh();
                    break;
                }

                case "reorderObjects": {
                    const cfg = readDmConfig(this._workspaceRoot);
                    const ids: string[] = msg.ids;
                    cfg.objects = ids.map((id) => cfg.objects.find((o) => o.id === id)!).filter(Boolean);
                    writeDmConfig(this._workspaceRoot, cfg);
                    this._config = cfg;
                    this._refresh();
                    break;
                }

                case "autoSort": {
                    let cfg = readDmConfig(this._workspaceRoot);
                    try {
                        const noop = () => {};
                        cfg = await autoSortByDependencies(msg.targetOrg || "", this._workspaceRoot, cfg, noop);
                    } catch { /* leave order unchanged on error */ }
                    writeDmConfig(this._workspaceRoot, cfg);
                    this._config = cfg;
                    this._refresh();
                    break;
                }

                case "setSourceOrg":
                    setSourceOrg(this._ctx, msg.alias);
                    break;

                case "setTargetOrg":
                    setTargetOrg(this._ctx, msg.alias);
                    break;

                case "pull":
                    await this._startPull(msg.sourceOrg, !!msg.dryRun);
                    break;

                case "load":
                    await this._startLoad(msg.targetOrg, !!msg.dryRun);
                    break;

                case "pullAndLoad":
                    await this._startPullAndLoad(msg.sourceOrg, msg.targetOrg, !!msg.dryRun);
                    break;

                case "pause":
                    this._runController?.pause();
                    this._runState = "paused";
                    break;

                case "resume":
                    this._runController?.resume();
                    this._runState = "running";
                    break;

                case "skipObject":
                    this._runController?.skipObject();
                    break;

                case "cancel":
                    this._runController?.cancel();
                    this._runState = "idle";
                    break;

                case "retryFailed": {
                    const cfg = readDmConfig(this._workspaceRoot);
                    this._config = cfg;
                    await this._startLoad(msg.targetOrg, false, msg.sobject);
                    break;
                }

                case "rollback":
                    await this._handleRollback(msg.targetOrg, !!msg.dryRun);
                    break;

                case "clearObject":
                    await this._handleClearObject(msg.sobject, msg.targetOrg);
                    break;

                case "exportCsv":
                    await this._handleExportCsv(msg.targetOrg);
                    break;

                case "viewLog":
                    await this._handleViewLog();
                    break;

                case "checkExtId":
                    await this._handleCheckExtId(msg.sobject, msg.targetOrg);
                    break;

                case "checkAllExtIds":
                    await this._handleCheckAllExtIds(msg.targetOrg);
                    break;

                case "createExtId":
                    await this._handleCreateExtId(msg.sobject, msg.targetOrg);
                    break;

                case "createAllExtIds":
                    await this._handleCreateAllExtIds(msg.targetOrg);
                    break;

                case "refreshOrgs": {
                    this._panel.webview.postMessage({ command: "logLine", text: "Refreshing org list...", level: "info" });
                    listAvailableOrgs(this._workspaceRoot)
                        .then(orgs => { this._availableOrgs = orgs; this._refresh(); })
                        .catch(() => this._refresh());
                    break;
                }

                case "elevateRole":
                    await vscode.commands.executeCommand("sfDevops.changeRole");
                    this._refresh();
                    break;

                case "openConnectOrg": {
                    const terminal = vscode.window.createTerminal("SF Org Login");
                    terminal.show();
                    terminal.sendText("sf org login web");
                    break;
                }

                case "exportDryRunReport":
                    await this._handleExportDryRunReport();
                    break;

                case "openConfigJson": {
                    const cfgPath = path.join(this._workspaceRoot, ".sf-devops-dm.json");
                    if (!fs.existsSync(cfgPath)) { writeDmConfig(this._workspaceRoot, this._config); }
                    const doc = await vscode.workspace.openTextDocument(cfgPath);
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                    break;
                }
            }
        }, null, this._disposables);

        this._panel.webview.html = loadingHtml("Loading Data Migration...");
        // Load available orgs once, non-blocking — cached for the lifetime of the panel
        listAvailableOrgs(this._workspaceRoot)
            .then(orgs => { this._availableOrgs = orgs; })
            .catch(() => {})
            .finally(() => this._refresh());

        // Watch .sf-devops-dm.json so external edits (e.g. via "Edit Raw JSON") auto-refresh
        const configPattern = new vscode.RelativePattern(this._workspaceRoot, ".sf-devops-dm.json");
        const cfgWatcher = vscode.workspace.createFileSystemWatcher(configPattern, true, false, true);
        cfgWatcher.onDidChange(() => {
            try { this._config = readDmConfig(this._workspaceRoot); } catch { /* ignore parse errors */ }
            this._refresh();
        }, null, this._disposables);
        this._disposables.push(cfgWatcher);
    }

    private _dispose(): void {
        DataMigrationPanel._current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    // ── refresh ──────────────────────────────────────────────────────────────

    private _refresh(): void {
        if (this._refreshing) { return; }
        this._refreshing = true;
        try {
            const vm = this._buildViewModel();
            this._panel.webview.html = this._renderHtml(vm);
        } catch (err) {
            this._panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">Error: ${esc(String(err))}</body>`;
        } finally {
            this._refreshing = false;
        }
    }

    // ── view model ───────────────────────────────────────────────────────────

    private _buildViewModel() {
        const config    = readDmConfig(this._workspaceRoot);
        this._config    = config;
        const sourceOrg = getSourceOrg(this._ctx) || "";
        const targetOrg = getTargetOrg(this._ctx) || "";
        const role      = getEffectiveRole(this._ctx);
        const envs      = getEnvironments();
        const tracking  = targetOrg ? readTracking(this._workspaceRoot, targetOrg) : {};
        const logPath   = lastRunLogPath(this._workspaceRoot);
        const hasLog    = fs.existsSync(logPath);
        return {
            config,
            sourceOrg,
            targetOrg,
            role,
            envs,
            tracking,
            hasLog,
            availableOrgs: this._availableOrgs,
            runState:  this._runState,
            activeTab: this._activeTab,
            dryRun:    this._dryRunMode,
            logLines:  this._logLines,
        };
    }

    // ── operations ───────────────────────────────────────────────────────────

    private _makeLogHandlers() {
        const onLog = (text: string, level: string) => {
            const line = `[${new Date().toLocaleTimeString()}]  ${text}`;
            this._logLines.push(line);
            if (this._logLines.length > 2000) { this._logLines.shift(); }
            this._panel.webview.postMessage({ command: "logLine", text: line, level });
            log(`[DM] ${text}`);
        };
        const onProgress = (evt: DmProgressEvent) => {
            this._panel.webview.postMessage({ command: "progress", data: evt });
        };
        return { onLog, onProgress };
    }

    private async _startPull(sourceOrg: string, dryRun: boolean): Promise<void> {
        this._runState = "running";
        this._logLines = [];
        this._dryRunMode = dryRun;
        const ctrl = makeController();
        this._runController = ctrl;
        const { onLog, onProgress } = this._makeLogHandlers();
        this._refresh();
        try {
            await pullData(sourceOrg, this._workspaceRoot, this._config, onLog, onProgress, ctrl, { dryRun, dryRunSampleSize: 5 });
            this._panel.webview.postMessage({ command: "runDone", op: "pull", dryRun });
        } catch (err) {
            this._panel.webview.postMessage({ command: "runError", message: String(err) });
        } finally {
            this._runState = "idle";
            this._runController = undefined;
        }
    }

    private async _startLoad(targetOrg: string, dryRun: boolean, sobject?: string): Promise<void> {
        this._runState = "running";
        this._logLines = [];
        this._dryRunMode = dryRun;
        const ctrl = makeController();
        this._runController = ctrl;
        const { onLog, onProgress } = this._makeLogHandlers();
        this._refresh();
        try {
            await loadData(targetOrg, this._workspaceRoot, this._config, onLog, onProgress, ctrl, { dryRun, objectFilter: sobject ? [sobject] : undefined });
            this._panel.webview.postMessage({ command: "runDone", op: "load", dryRun });
        } catch (err) {
            this._panel.webview.postMessage({ command: "runError", message: String(err) });
        } finally {
            this._runState = "idle";
            this._runController = undefined;
        }
    }

    private async _startPullAndLoad(sourceOrg: string, targetOrg: string, dryRun: boolean): Promise<void> {
        this._runState = "running";
        this._logLines = [];
        this._dryRunMode = dryRun;
        const ctrl = makeController();
        this._runController = ctrl;
        const { onLog, onProgress } = this._makeLogHandlers();
        this._refresh();
        try {
            await pullData(sourceOrg, this._workspaceRoot, this._config, onLog, onProgress, ctrl, { dryRun, dryRunSampleSize: 5 });
            if (ctrl.state !== "cancelled") {
                await loadData(targetOrg, this._workspaceRoot, this._config, onLog, onProgress, ctrl, { dryRun });
            }
            this._panel.webview.postMessage({ command: "runDone", op: "pullAndLoad", dryRun });
        } catch (err) {
            this._panel.webview.postMessage({ command: "runError", message: String(err) });
        } finally {
            this._runState = "idle";
            this._runController = undefined;
        }
    }

    private async _handleRollback(targetOrg: string, dryRun: boolean): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `This will delete all tracked records from ${targetOrg}. Type DELETE to confirm.`,
            { modal: true }, "DELETE"
        );
        if (confirm !== "DELETE") { return; }
        this._runState = "running";
        this._logLines = [];
        const ctrl = makeController();
        this._runController = ctrl;
        const { onLog, onProgress } = this._makeLogHandlers();
        this._refresh();
        try {
            await rollbackData(targetOrg, this._workspaceRoot, this._config, onLog, { dryRun });
            this._panel.webview.postMessage({ command: "runDone", op: "rollback", dryRun });
        } catch (err) {
            this._panel.webview.postMessage({ command: "runError", message: String(err) });
        } finally {
            this._runState = "idle";
            this._runController = undefined;
        }
    }

    private async _handleClearObject(sobject: string, targetOrg: string): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            `Delete all tracked records for ${sobject} in ${targetOrg}?`,
            { modal: true }, "Delete"
        );
        if (confirm !== "Delete") { return; }
        const { onLog } = this._makeLogHandlers();
        try {
            await rollbackData(targetOrg, this._workspaceRoot, this._config, onLog, { dryRun: false, objectFilter: [sobject] });
            vscode.window.showInformationMessage(`Cleared records for ${sobject}.`);
        } catch (err) {
            vscode.window.showErrorMessage(`Clear failed: ${String(err)}`);
        }
        this._refresh();
    }

    private async _handleExportCsv(targetOrg: string): Promise<void> {
        try {
            const tracking = readTracking(this._workspaceRoot, targetOrg);
            const rows: string[] = ["Object,Total,Created,Failed,Skipped,Pending,Blocked"];
            for (const [obj, entries] of Object.entries(tracking)) {
                const counts = { created: 0, failed: 0, skipped: 0, pending: 0, blocked: 0 };
                for (const e of Object.values(entries)) {
                    if (e.status in counts) { (counts as any)[e.status]++; }
                    else { counts.pending++; }
                }
                const total = Object.keys(entries).length;
                rows.push([obj, total, counts.created, counts.failed, counts.skipped, counts.pending, counts.blocked].join(","));
            }
            const outPath = path.join(this._workspaceRoot, `dm-tracking-${targetOrg}-${Date.now()}.csv`);
            fs.writeFileSync(outPath, rows.join("\n"), "utf8");
            const doc = await vscode.workspace.openTextDocument(outPath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        } catch (err) {
            vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
        }
    }

    private async _handleViewLog(): Promise<void> {
        const logPath = lastRunLogPath(this._workspaceRoot);
        if (!fs.existsSync(logPath)) {
            vscode.window.showWarningMessage("No log file found.");
            return;
        }
        const doc = await vscode.workspace.openTextDocument(logPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    }

    private async _handleCheckExtId(sobject: string, targetOrg: string): Promise<void> {
        const { onLog } = this._makeLogHandlers();
        try {
            const fieldName = await checkExternalId(targetOrg, sobject, this._workspaceRoot, onLog);
            const cfg = readDmConfig(this._workspaceRoot);
            const obj = cfg.objects.find((o) => o.sobject === sobject);
            if (obj) {
                obj.externalIdVerified = !!fieldName;
                if (fieldName) { obj.externalIdField = fieldName; }
                writeDmConfig(this._workspaceRoot, cfg);
                this._config = cfg;
            }
            onLog(`External ID check for ${sobject}: ${fieldName ? "Found — " + fieldName : "Not found"}`, fieldName ? "success" : "warn");
        } catch (err) {
            onLog(`External ID check failed for ${sobject}: ${String(err)}`, "error");
        }
        this._refresh();
    }

    private async _handleCheckAllExtIds(targetOrg: string): Promise<void> {
        const { onLog } = this._makeLogHandlers();
        const cfg = readDmConfig(this._workspaceRoot);
        for (const obj of cfg.objects.filter((o) => o.active !== false)) {
            try {
                const fieldName = await checkExternalId(targetOrg, obj.sobject, this._workspaceRoot, onLog);
                obj.externalIdVerified = !!fieldName;
                if (fieldName) { obj.externalIdField = fieldName; }
                onLog(`${obj.sobject}: ${fieldName ? "✓ " + fieldName : "✗ not found"}`, fieldName ? "success" : "warn");
            } catch (err) {
                onLog(`${obj.sobject}: check error — ${String(err)}`, "error");
            }
        }
        writeDmConfig(this._workspaceRoot, cfg);
        this._config = cfg;
        this._refresh();
    }

    private async _handleCreateExtId(sobject: string, targetOrg: string): Promise<void> {
        const { onLog } = this._makeLogHandlers();
        try {
            const fieldName = await createExternalIdField(targetOrg, sobject, this._workspaceRoot, onLog);
            const cfg = readDmConfig(this._workspaceRoot);
            const obj = cfg.objects.find((o) => o.sobject === sobject);
            if (obj) {
                obj.externalIdField = fieldName;
                obj.externalIdVerified = true;
                writeDmConfig(this._workspaceRoot, cfg);
                this._config = cfg;
            }
            onLog(`Created ExternalId field for ${sobject}: ${fieldName}`, "success");
        } catch (err) {
            onLog(`Failed to create ExternalId for ${sobject}: ${String(err)}`, "error");
        }
        this._refresh();
    }

    private async _handleCreateAllExtIds(targetOrg: string): Promise<void> {
        const { onLog } = this._makeLogHandlers();
        const cfg = readDmConfig(this._workspaceRoot);
        for (const obj of cfg.objects.filter((o) => o.active !== false && !o.externalIdVerified)) {
            try {
                const fieldName = await createExternalIdField(targetOrg, obj.sobject, this._workspaceRoot, onLog);
                obj.externalIdField = fieldName;
                obj.externalIdVerified = true;
                onLog(`Created ExternalId for ${obj.sobject}: ${fieldName}`, "success");
            } catch (err) {
                onLog(`Failed for ${obj.sobject}: ${String(err)}`, "error");
            }
        }
        writeDmConfig(this._workspaceRoot, cfg);
        this._config = cfg;
        this._refresh();
    }

    private async _handleExportDryRunReport(): Promise<void> {
        try {
            const lines = this._logLines;
            const outPath = path.join(this._workspaceRoot, `dm-dryrun-report-${Date.now()}.csv`);
            fs.writeFileSync(outPath, lines.join("\n"), "utf8");
            const doc = await vscode.workspace.openTextDocument(outPath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        } catch (err) {
            vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
        }
    }

    // ── HTML rendering ───────────────────────────────────────────────────────

    private static _accessDeniedHtml(webview: vscode.Webview, role: string, required: string): string {
        return `<!DOCTYPE html><html><head>${cspMeta(webview)}<style>
        body{font-family:var(--vscode-font-family);background:var(--vscode-editor-background);color:var(--vscode-foreground);display:flex;align-items:center;justify-content:center;height:100vh;margin:0;}
        .box{text-align:center;max-width:400px;}
        h2{color:#F44336;margin-bottom:8px;}
        p{color:var(--vscode-descriptionForeground);margin-bottom:24px;}
        .btn{background:#00C9B1;color:#000;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-size:13px;}
        .btn:hover{opacity:0.85;}
        </style></head><body>
        <div class="box">
            <h2>Access Denied</h2>
            <p>This panel requires <strong>${esc(required)}</strong> role or higher.<br>Your current role is <strong>${esc(role)}</strong>.</p>
            <button class="btn" onclick="send('elevateRole')">Elevate Role</button>
        </div>
        <script>const vscode=acquireVsCodeApi();function send(cmd){vscode.postMessage({command:cmd});}</script>
        </html>`;
    }

    private _renderHtml(vm: Awaited<ReturnType<DataMigrationPanel["_buildViewModel"]>>): string {
        const { config, sourceOrg, targetOrg, role, envs, tracking, hasLog, availableOrgs, runState, activeTab, dryRun, logLines } = vm;

        // Build pipeline orgs list
        const pipelineAliases = new Set<string>();
        const envEntries = Object.entries(envs ?? {});
        const slotEntries = Object.entries(getOrgAliasSlots?.() ?? {});
        for (const [, v] of [...envEntries, ...slotEntries]) {
            if (typeof v === "string" && v) { pipelineAliases.add(v); }
        }

        const pipelineOrgs = [...pipelineAliases].map((a) => ({ alias: a, username: a }));
        const otherOrgs = (availableOrgs || []).filter((o) => !pipelineAliases.has(o.alias));

        function orgOptions(selectedAlias: string): string {
            let out = "";
            out += `<optgroup label="Pipeline Orgs">`;
            for (const o of pipelineOrgs) {
                out += `<option value="${esc(o.alias)}"${o.alias === selectedAlias ? " selected" : ""}>${esc(o.alias)}</option>`;
            }
            out += `</optgroup>`;
            out += `<optgroup label="Other Orgs">`;
            for (const o of otherOrgs) {
                out += `<option value="${esc(o.alias)}"${o.alias === selectedAlias ? " selected" : ""}>${esc(o.alias)} — ${esc(o.username)}</option>`;
            }
            out += `</optgroup>`;
            out += `<option value="**connect**">+ Connect New Org…</option>`;
            return out;
        }

        const tabs: { id: string; label: string }[] = [
            { id: "config",   label: "⚙ Config" },
            { id: "run",      label: "▶ Run" },
            { id: "tracking", label: "📊 Tracking" },
            { id: "extids",   label: "🔑 External IDs" },
        ];

        // ── Tab 1: Config ────────────────────────────────────────────────────
        const renderConfigTab = () => {
            const objects = config.objects ?? [];
            let rows = "";
            objects.forEach((obj, idx) => {
                const active = obj.active !== false;
                const extIdBadge = obj.externalIdVerified
                    ? `<span class="badge badge-green" title="${esc(obj.externalIdField ?? "")}">✅ ${esc(obj.externalIdField ?? "")}</span>`
                    : `<span class="badge badge-amber" style="cursor:pointer" onclick="send('switchTab',{tab:'extids'})">⚠️ Not set</span>`;
                const queryPreview = (obj.query || "").length > 60 ? esc(obj.query!.slice(0, 60)) + "…" : esc(obj.query ?? "");
                rows += `
                <tr id="row-${esc(obj.id)}" class="${active ? "" : "inactive-row"}">
                    <td>${idx + 1}</td>
                    <td><code>${esc(obj.sobject)}</code></td>
                    <td>${esc(obj.label ?? obj.sobject)}</td>
                    <td>${esc((obj.dependsOn ?? []).join(", "))}</td>
                    <td title="${esc(obj.query ?? "")}">${queryPreview}</td>
                    <td><label class="toggle-sw"><input type="checkbox" ${active ? "checked" : ""} onchange="send('updateObject',{obj:Object.assign({},DATA.config.objects[${idx}],{active:this.checked})})"><span class="slider"></span></label></td>
                    <td>${extIdBadge}</td>
                    <td class="row-actions">
                        <button class="icon-btn" title="Edit" onclick="openInlineEditor(${idx})">✏️</button>
                        <button class="icon-btn" title="Move Up" onclick="moveObj(${idx},-1)" ${idx === 0 ? "disabled" : ""}>▲</button>
                        <button class="icon-btn" title="Move Down" onclick="moveObj(${idx},1)" ${idx === objects.length - 1 ? "disabled" : ""}>▼</button>
                        <button class="icon-btn danger-btn" title="Delete" onclick="if(confirm('Delete '+${JSON.stringify(esc(obj.sobject))}+'?'))send('deleteObject',{id:${JSON.stringify(obj.id)}})">🗑</button>
                    </td>
                </tr>
                <tr id="editor-${esc(obj.id)}" class="inline-editor-row" style="display:none">
                    <td colspan="8">
                        <div class="inline-editor">
                            <div class="field-row">
                                <label>Label</label>
                                <input id="ed-label-${esc(obj.id)}" value="${esc(obj.label ?? "")}" />
                            </div>
                            <div class="field-row">
                                <label>Object API Name</label>
                                <input id="ed-sobject-${esc(obj.id)}" value="${esc(obj.sobject)}" />
                            </div>
                            <div class="field-row">
                                <label>SOQL Query</label>
                                <textarea id="ed-query-${esc(obj.id)}" rows="3">${esc(obj.query ?? "")}</textarea>
                            </div>
                            <div class="field-row">
                                <label>External ID Field</label>
                                <input id="ed-extid-${esc(obj.id)}" value="${esc(obj.externalIdField ?? "")}" />
                            </div>
                            <div class="field-row">
                                <label>Depends On (comma-separated)</label>
                                <input id="ed-deps-${esc(obj.id)}" value="${esc((obj.dependsOn ?? []).join(", "))}" />
                            </div>
                            <div style="display:flex;gap:8px;margin-top:8px">
                                <button class="btn btn-primary" onclick="saveInlineEditor(${idx})">Save</button>
                                <button class="btn" onclick="closeInlineEditor('${esc(obj.id)}')">Cancel</button>
                            </div>
                        </div>
                    </td>
                </tr>`;
            });

            return `
            <div class="settings-card">
                <h3>Settings</h3>
                <div class="toggle-row">
                    <label class="toggle-sw"><input type="checkbox" id="autoCreateExtId" ${config.autoCreateExternalId ? "checked" : ""} onchange="pendingSettings.autoCreateExternalId=this.checked"><span class="slider"></span></label>
                    <span class="toggle-label">Auto-create External ID fields before every Load</span>
                </div>
                <div class="field-row">
                    <label>Batch size</label>
                    <input type="number" id="batchSize" value="${esc(String(config.batchSize ?? 190))}" min="1" max="10000" style="width:90px;flex:none" oninput="pendingSettings.batchSize=+this.value" />
                </div>
                <div style="margin-top:12px">
                    <button class="btn btn-primary" onclick="saveSettings()">Save Settings</button>
                </div>
            </div>

            <div class="toolbar" style="margin-top:16px">
                <button class="btn btn-primary" onclick="openAddObjectModal()">+ Add Object</button>
                <button class="btn" onclick="send('autoSort',{targetOrg:document.getElementById('sortTargetOrg').value})">Auto-Sort by Dependencies</button>
                <button class="btn" onclick="saveOrder()">Save Order</button>
                <button class="btn" onclick="send('openConfigJson',{})" title="Open .sf-devops-dm.json in editor — changes auto-refresh this panel on save">&#128196; Edit Raw JSON</button>
                <select id="sortTargetOrg" class="select" style="margin-left:auto">
                    ${orgOptions(targetOrg)}
                </select>
            </div>

            ${objects.length === 0
                ? `<p style="color:var(--vscode-descriptionForeground)">No objects configured. Click "+ Add Object" to get started.</p>`
                : `<div class="table-wrap"><table class="data-table">
                <thead><tr><th>#</th><th>Object</th><th>Label</th><th>Depends On</th><th>Query</th><th>Active</th><th>Ext ID</th><th>Actions</th></tr></thead>
                <tbody id="objects-tbody">${rows}</tbody>
            </table></div>`}

            <div id="add-object-modal" class="modal" style="display:none">
                <div class="modal-box">
                    <h3>Add Object</h3>
                    <div class="field-row"><label>Label</label><input id="new-label" placeholder="e.g. Account" /></div>
                    <div class="field-row"><label>Object API Name</label><input id="new-sobject" placeholder="e.g. Account" /></div>
                    <div class="field-row"><label>SOQL Query</label><textarea id="new-query" rows="3" placeholder="SELECT Id, Name FROM Account"></textarea></div>
                    <div class="field-row"><label>External ID Field</label><input id="new-extid" placeholder="e.g. ExternalId__c" /></div>
                    <div class="field-row"><label>Depends On (comma-separated)</label><input id="new-deps" placeholder="e.g. Account, Contact" /></div>
                    <div style="display:flex;gap:8px;margin-top:12px">
                        <button class="btn btn-primary" onclick="submitAddObject()">Add</button>
                        <button class="btn" onclick="closeAddObjectModal()">Cancel</button>
                    </div>
                </div>
            </div>`;
        };

        // ── Tab 2: Run ───────────────────────────────────────────────────────
        const renderRunTab = () => {
            const isActive = runState === "running" || runState === "paused";
            const isDone   = runState === "done";

            if (isActive) {
                const bannerClass = dryRun ? "banner-amber" : "banner-teal";
                const bannerLabel = dryRun ? "DRY RUN" : "RUNNING";
                return `
                <div class="run-banner ${bannerClass}" id="run-banner">
                    <span id="run-op-label">${bannerLabel}</span>
                    <span style="flex:1"></span>
                    <span id="run-elapsed">00:00</span>
                </div>
                ${runState === "paused" ? `<div class="paused-overlay"><span>⏸ Paused</span></div>` : ""}
                <div class="progress-container ${runState === "paused" ? "dimmed" : ""}">
                    <div class="current-obj" id="current-obj">Initializing…</div>
                    <div class="progress-track"><div class="progress-bar" id="progress-bar-obj" style="width:0%"></div></div>
                    <div class="progress-label" id="progress-label-obj">0 / 0</div>
                    <div class="progress-track" style="margin-top:4px"><div class="progress-bar progress-bar-overall" id="progress-bar-overall" style="width:0%"></div></div>
                    <div class="progress-label" id="progress-label-overall">Overall: 0 / ${config.objects.filter(o => o.active !== false).length}</div>
                </div>
                <div class="run-controls">
                    ${runState === "paused"
                        ? `<button class="btn btn-primary" onclick="send('resume')">▶ Resume</button>`
                        : `<button class="btn" onclick="send('pause')">⏸ Pause</button>`}
                    <button class="btn" onclick="send('skipObject')">⏭ Skip Object</button>
                    <button class="btn danger-btn" onclick="send('cancel')">✕ Cancel</button>
                </div>
                <div class="log-area" id="log-area">${logLines.map((l) => `<div class="log-line">${esc(l)}</div>`).join("")}</div>`;
            }

            return `
            <div class="run-idle-card">
                <div class="field-row" style="margin-bottom:12px">
                    <label style="width:100px">Source Org</label>
                    <select id="sourceOrgSel" class="select" onchange="if(this.value==='**connect**')send('openConnectOrg');else send('setSourceOrg',{alias:this.value})">
                        ${orgOptions(sourceOrg)}
                    </select>
                    <button class="icon-btn" onclick="send('refreshOrgs')" title="Refresh orgs">🔄</button>
                </div>
                <div class="field-row" style="margin-bottom:12px">
                    <label style="width:100px">Target Org</label>
                    <select id="targetOrgSel" class="select" onchange="if(this.value==='**connect**')send('openConnectOrg');else send('setTargetOrg',{alias:this.value})">
                        ${orgOptions(targetOrg)}
                    </select>
                </div>
                <div class="toggle-row" style="margin-bottom:16px">
                    <label class="toggle-sw"><input type="checkbox" id="dryRunToggle" ${dryRun ? "checked" : ""}><span class="slider"></span></label>
                    <span class="toggle-label">Dry Run — preview only, no changes made</span>
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    <button class="btn btn-primary" onclick="startPull()">⬇ Pull from Source</button>
                    <button class="btn btn-primary" onclick="startLoad()">⬆ Load to Target</button>
                    <button class="btn btn-accent" onclick="startPullAndLoad()">⬇⬆ Pull + Load</button>
                </div>
                ${isDone ? `<div class="done-banner">✅ Operation complete. Check the Tracking tab for results.</div>` : ""}
            </div>
            <div class="log-area" id="log-area" style="margin-top:16px">${logLines.map((l) => `<div class="log-line">${esc(l)}</div>`).join("")}</div>`;
        };

        // ── Tab 3: Tracking ──────────────────────────────────────────────────
        const renderTrackingTab = () => {
            const entries = Object.entries(tracking ?? {});
            if (entries.length === 0) {
                return `<p style="color:var(--vscode-descriptionForeground)">No tracking data for <strong>${esc(targetOrg || "(no target org)")}</strong>. Run a load operation first.</p>`;
            }

            let rows = "";
            for (const [obj, t] of entries) {
                let created = 0, failed = 0, skipped = 0, pending = 0, blocked = 0;
                for (const entry of Object.values(t)) {
                    if      (entry.status === "created") { created++; }
                    else if (entry.status === "failed")  { failed++; }
                    else if (entry.status === "skipped") { skipped++; }
                    else if (entry.status === "blocked") { blocked++; }
                    else                                 { pending++; }
                }
                const pulled = Object.keys(t).length;
                rows += `<tr>
                    <td><code>${esc(obj)}</code></td>
                    <td>${pulled}</td>
                    <td>${created}</td>
                    <td class="${failed > 0 ? "cell-red" : ""}">${failed}</td>
                    <td>${skipped}</td>
                    <td>${pending}</td>
                    <td>${blocked}</td>
                    <td class="row-actions">
                        ${failed > 0 ? `<button class="btn btn-sm" onclick="send('retryFailed',{sobject:${JSON.stringify(obj)},targetOrg:${JSON.stringify(targetOrg)}})">Retry Failed</button>` : ""}
                        <button class="btn btn-sm danger-btn" onclick="if(confirm('Clear '+${JSON.stringify(esc(obj))}+'?'))send('clearObject',{sobject:${JSON.stringify(obj)},targetOrg:${JSON.stringify(targetOrg)}})">Clear</button>
                    </td>
                </tr>`;
            }

            return `
            <div class="table-wrap">
                <table class="data-table">
                    <thead><tr><th>Object</th><th>Pulled</th><th>Created</th><th>Failed</th><th>Skipped</th><th>Pending</th><th>Blocked</th><th>Actions</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="toolbar" style="margin-top:16px">
                <button class="btn btn-primary" onclick="send('retryFailed',{targetOrg:${JSON.stringify(targetOrg)}})">Retry All Failed</button>
                <button class="btn danger-btn" onclick="send('rollback',{targetOrg:${JSON.stringify(targetOrg)},dryRun:false})">Full Rollback</button>
                <button class="btn" onclick="send('exportCsv',{targetOrg:${JSON.stringify(targetOrg)}})">Export CSV</button>
                ${hasLog ? `<button class="btn" onclick="send('viewLog')">View Log</button>` : ""}
            </div>`;
        };

        // ── Tab 4: External IDs ──────────────────────────────────────────────
        const renderExtIdsTab = () => {
            const activeObjs = (config.objects ?? []).filter((o) => o.active !== false);
            if (activeObjs.length === 0) {
                return `<p style="color:var(--vscode-descriptionForeground)">No active objects configured.</p>`;
            }

            let rows = "";
            for (const obj of activeObjs) {
                const status = obj.externalIdVerified
                    ? `<span class="badge badge-green">✅ Verified</span>`
                    : `<span class="badge badge-amber">⚠️ Not set</span>`;
                rows += `<tr>
                    <td><code>${esc(obj.sobject)}</code></td>
                    <td>${esc(obj.externalIdField ?? "—")}</td>
                    <td>${status}</td>
                    <td class="row-actions">
                        <button class="btn btn-sm" onclick="send('checkExtId',{sobject:${JSON.stringify(obj.sobject)},targetOrg:${JSON.stringify(targetOrg)}})">Re-check</button>
                        ${!obj.externalIdVerified ? `<button class="btn btn-sm btn-primary" onclick="send('createExtId',{sobject:${JSON.stringify(obj.sobject)},targetOrg:${JSON.stringify(targetOrg)}})">Auto-Create</button>` : ""}
                    </td>
                </tr>`;
            }

            return `
            <div class="table-wrap">
                <table class="data-table">
                    <thead><tr><th>Object</th><th>External ID Field</th><th>Status</th><th>Actions</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="toolbar" style="margin-top:16px">
                <button class="btn btn-primary" onclick="send('checkAllExtIds',{targetOrg:${JSON.stringify(targetOrg)}})">Re-check All</button>
                <button class="btn" onclick="send('createAllExtIds',{targetOrg:${JSON.stringify(targetOrg)}})">Auto-Create All Missing</button>
            </div>
            <div class="log-area" id="log-area" style="margin-top:16px">${logLines.map((l) => `<div class="log-line">${esc(l)}</div>`).join("")}</div>`;
        };

        const tabContent = activeTab === "config"   ? renderConfigTab()
                         : activeTab === "run"      ? renderRunTab()
                         : activeTab === "tracking" ? renderTrackingTab()
                         :                            renderExtIdsTab();

        const tabNav = tabs.map(({ id, label }) =>
            `<button class="tab-btn ${activeTab === id ? "tab-active" : ""}" onclick="send('switchTab',{tab:'${id}'})">${label}</button>`
        ).join("");

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${cspMeta(this._panel.webview)}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Data Migration</title>
<style>
${sharedCss()}

/* ── Layout ── */
body { padding: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
.sticky-header { position: sticky; top: 0; z-index: 100; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
.panel-title-bar { display: flex; align-items: center; gap: 12px; padding: 10px 20px 0; }
.panel-title { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.role-badge { font-size: 10px; background: #00C9B1; color: #000; border-radius: 4px; padding: 2px 7px; font-weight: 600; text-transform: uppercase; }
.org-bar { display: flex; align-items: center; gap: 8px; padding: 8px 20px; flex-wrap: wrap; }
.org-bar label { font-size: 11px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
.arrow { color: #00C9B1; font-size: 16px; font-weight: 700; }
.tab-bar { display: flex; gap: 2px; padding: 0 20px; border-bottom: 1px solid var(--vscode-panel-border); }
.tab-btn { background: none; border: none; border-bottom: 3px solid transparent; cursor: pointer; padding: 8px 16px; font-size: 13px; color: var(--vscode-foreground); font-family: var(--vscode-font-family); transition: color 0.15s; }
.tab-btn:hover { color: #00C9B1; }
.tab-active { border-bottom-color: #00C9B1 !important; color: #00C9B1 !important; font-weight: 600; }
.tab-content { flex: 1; overflow-y: auto; padding: 20px 20px 60px; }

/* ── Buttons ── */
.btn { display:inline-flex;align-items:center;gap:5px;font-family:var(--vscode-font-family);font-size:12px;padding:5px 12px;border-radius:4px;cursor:pointer;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground); }
.btn:hover { opacity: 0.85; }
.btn:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn-accent { background: #00C9B1; color: #000; font-weight: 600; }
.btn-sm { padding: 3px 8px; font-size: 11px; }
.danger-btn { border-color: #F44336; color: #F44336; }
.icon-btn { background: none; border: none; cursor: pointer; padding: 2px 5px; font-size: 14px; }
.icon-btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* ── Select ── */
.select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 4px 8px; border-radius: 4px; font-family: var(--vscode-font-family); font-size: 12px; }

/* ── Toggle switch ── */
.toggle-sw { position: relative; display: inline-block; width: 34px; height: 18px; vertical-align: middle; }
.toggle-sw input { opacity: 0; width: 0; height: 0; }
.slider { position: absolute; cursor: pointer; inset: 0; background: #888; border-radius: 18px; transition: 0.2s; }
.slider::before { content: ""; position: absolute; height: 12px; width: 12px; left: 3px; bottom: 3px; background: #fff; border-radius: 50%; transition: 0.2s; }
input:checked + .slider { background: #00C9B1; }
input:checked + .slider::before { transform: translateX(16px); }

/* ── Tables ── */
.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.data-table th { text-align: left; padding: 6px 10px; background: var(--vscode-editorGroupHeader-tabsBackground); font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; border-bottom: 1px solid var(--vscode-panel-border); }
.data-table td { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border,rgba(128,128,128,0.15)); vertical-align: middle; }
.data-table tr:hover > td { background: var(--vscode-list-hoverBackground); }
.inactive-row td { opacity: 0.5; }
.row-actions { white-space: nowrap; }
.cell-red { color: #F44336; font-weight: 600; }

/* ── Badges ── */
.badge { font-size: 10px; padding: 2px 6px; border-radius: 3px; font-weight: 600; }
.badge-green { background: rgba(76,175,80,0.2); color: #4CAF50; }
.badge-amber { background: rgba(255,193,7,0.15); color: #FFC107; }

/* ── Field rows ── */
.field-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.field-row label:not(.toggle-sw) { min-width: 110px; font-size: 12px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
.field-row input, .field-row textarea, .field-row select { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border,transparent); padding: 4px 8px; border-radius: 3px; font-family: var(--vscode-editor-font-family,monospace); font-size: 12px; }
.field-row textarea { resize: vertical; }
/* toggle row — no label min-width, items flow naturally */
.toggle-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.toggle-row .toggle-label { font-size: 12px; color: var(--vscode-foreground); }

/* ── Settings card ── */
.settings-card { background: var(--vscode-editorGroupHeader-tabsBackground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 14px 16px; margin-bottom: 16px; max-width: 480px; }

/* ── Inline editor ── */
.inline-editor-row { background: var(--vscode-editorGroupHeader-tabsBackground); }
.inline-editor { padding: 12px 16px; border-top: 2px solid #00C9B1; }

/* ── Modal ── */
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 200; }
.modal-box { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 24px; width: 480px; max-width: 90vw; }

/* ── Run tab ── */
.run-idle-card { background: var(--vscode-editorGroupHeader-tabsBackground); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 20px; max-width: 560px; }
.run-banner { display: flex; align-items: center; padding: 10px 16px; border-radius: 6px; font-weight: 700; font-size: 14px; margin-bottom: 16px; }
.banner-teal { background: #00C9B1; color: #000; }
.banner-amber { background: #FFC107; color: #000; }
.paused-overlay { background: rgba(0,0,0,0.3); border: 2px solid #FFC107; border-radius: 4px; padding: 8px 16px; color: #FFC107; font-weight: 700; margin-bottom: 12px; text-align: center; }
.progress-container { background: var(--vscode-editorGroupHeader-tabsBackground); border-radius: 6px; padding: 14px; margin-bottom: 12px; }
.progress-container.dimmed { opacity: 0.5; }
.current-obj { font-weight: 600; margin-bottom: 8px; }
.progress-track { height: 6px; background: var(--vscode-panel-border); border-radius: 3px; overflow: hidden; }
.progress-bar { height: 100%; background: #00C9B1; border-radius: 3px; transition: width 0.3s; }
.progress-bar-overall { background: #4CAF50; }
.progress-label { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 3px; }
.run-controls { display: flex; gap: 8px; margin-bottom: 16px; }
.done-banner { background: rgba(76,175,80,0.15); border: 1px solid #4CAF50; border-radius: 4px; padding: 10px 14px; margin-top: 16px; color: #4CAF50; font-weight: 600; }

/* ── Log area ── */
.log-area { background: var(--vscode-terminal-background, #1e1e1e); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; max-height: 320px; overflow-y: auto; color: var(--vscode-terminal-foreground, #ccc); }
.log-line { white-space: pre-wrap; word-break: break-all; line-height: 1.55; }
.log-line.warn  { color: #FFC107; }
.log-line.error { color: #F44336; }
.log-line.info  { color: #4CAF50; }

/* ── Toolbar ── */
.toolbar { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
</style>
</head>
<body>

<div class="sticky-header">
    <div class="panel-title-bar">
        <span class="panel-title">Salesforce-DevOps &mdash; Data Migration</span>
        <span class="role-badge">${esc(role)}</span>
    </div>
    <div class="org-bar">
        <label>Source</label>
        <select class="select" id="globalSourceOrg" onchange="if(this.value==='**connect**')send('openConnectOrg');else send('setSourceOrg',{alias:this.value})">
            ${orgOptions(sourceOrg)}
        </select>
        <span class="arrow">→</span>
        <label>Target</label>
        <select class="select" id="globalTargetOrg" onchange="if(this.value==='**connect**')send('openConnectOrg');else send('setTargetOrg',{alias:this.value})">
            ${orgOptions(targetOrg)}
        </select>
    </div>
    <div class="tab-bar">${tabNav}</div>
</div>

<div class="tab-content">
    ${tabContent}
</div>

<script>
(function() {
const vscode = acquireVsCodeApi();
const DATA = ${jsonInject(vm)};

let pendingSettings = {
    autoCreateExternalId: DATA.config.autoCreateExternalId,
    batchSize: DATA.config.batchSize
};

function send(cmd, payload) {
    vscode.postMessage(Object.assign({ command: cmd }, payload || {}));
}

function getVal(id) {
    const el = document.getElementById(id);
    return el ? el.value : '';
}

function getDryRun() {
    const el = document.getElementById('dryRunToggle');
    return el ? el.checked : false;
}

// ── Run controls ────────────────────────────────────────────────────────────
function startPull()        { send('pull',        { sourceOrg: getVal('sourceOrgSel'), dryRun: getDryRun() }); }
function startLoad()        { send('load',        { targetOrg: getVal('targetOrgSel'), dryRun: getDryRun() }); }
function startPullAndLoad() { send('pullAndLoad', { sourceOrg: getVal('sourceOrgSel'), targetOrg: getVal('targetOrgSel'), dryRun: getDryRun() }); }

// ── Settings ─────────────────────────────────────────────────────────────────
function saveSettings() {
    const cfg = Object.assign({}, DATA.config, pendingSettings);
    send('saveConfig', { config: cfg });
}

// ── Object ordering ──────────────────────────────────────────────────────────
function moveObj(idx, dir) {
    const ids = DATA.config.objects.map(o => o.id);
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= ids.length) { return; }
    const tmp = ids[idx]; ids[idx] = ids[newIdx]; ids[newIdx] = tmp;
    send('reorderObjects', { ids });
}

function saveOrder() {
    const ids = DATA.config.objects.map(o => o.id);
    send('reorderObjects', { ids });
}

// ── Inline editor ────────────────────────────────────────────────────────────
let openEditorId = null;
function openInlineEditor(idx) {
    const obj = DATA.config.objects[idx];
    if (!obj) { return; }
    if (openEditorId && openEditorId !== obj.id) { closeInlineEditor(openEditorId); }
    openEditorId = obj.id;
    const row = document.getElementById('editor-' + obj.id);
    if (row) { row.style.display = ''; }
}

function closeInlineEditor(id) {
    const row = document.getElementById('editor-' + id);
    if (row) { row.style.display = 'none'; }
    openEditorId = null;
}

function saveInlineEditor(idx) {
    const obj = DATA.config.objects[idx];
    if (!obj) { return; }
    const updated = Object.assign({}, obj, {
        label:           document.getElementById('ed-label-'   + obj.id)?.value ?? obj.label,
        sobject:         document.getElementById('ed-sobject-' + obj.id)?.value ?? obj.sobject,
        query:           document.getElementById('ed-query-'   + obj.id)?.value ?? obj.query,
        externalIdField: document.getElementById('ed-extid-'   + obj.id)?.value || obj.externalIdField,
        dependsOn:       (document.getElementById('ed-deps-'   + obj.id)?.value || '')
                            .split(',').map(s => s.trim()).filter(Boolean),
    });
    send('updateObject', { obj: updated });
}

// ── Add Object modal ─────────────────────────────────────────────────────────
function openAddObjectModal() {
    const m = document.getElementById('add-object-modal');
    if (m) { m.style.display = 'flex'; }
}

function closeAddObjectModal() {
    const m = document.getElementById('add-object-modal');
    if (m) { m.style.display = 'none'; }
}

function submitAddObject() {
    const label   = document.getElementById('new-label')?.value.trim();
    const sobject = document.getElementById('new-sobject')?.value.trim();
    const query   = document.getElementById('new-query')?.value.trim();
    const extid   = document.getElementById('new-extid')?.value.trim();
    const deps    = (document.getElementById('new-deps')?.value || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!sobject) { alert('Object API Name is required.'); return; }
    const id = sobject + '_' + Date.now();
    send('addObject', { obj: { id, label: label || sobject, sobject, query: query || '', externalIdField: extid || '', dependsOn: deps, active: true } });
    closeAddObjectModal();
}

// ── Live progress updates ────────────────────────────────────────────────────
let _elapsedSecs = 0;
let _elapsedTimer = null;

function startElapsedTimer() {
    _elapsedSecs = 0;
    if (_elapsedTimer) { clearInterval(_elapsedTimer); }
    _elapsedTimer = setInterval(function() {
        _elapsedSecs++;
        const el = document.getElementById('run-elapsed');
        if (el) {
            const m = String(Math.floor(_elapsedSecs / 60)).padStart(2,'0');
            const s = String(_elapsedSecs % 60).padStart(2,'0');
            el.textContent = m + ':' + s;
        }
    }, 1000);
}

function stopElapsedTimer() {
    if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
}

// Start timer if panel loaded mid-run
if (DATA.runState === 'running' || DATA.runState === 'paused') {
    startElapsedTimer();
}

function updateProgress(data) {
    const curObj = document.getElementById('current-obj');
    if (curObj && data.currentObject) { curObj.textContent = data.currentObject; }

    const barObj = document.getElementById('progress-bar-obj');
    const lblObj = document.getElementById('progress-label-obj');
    if (barObj && data.objectTotal > 0) {
        const pct = Math.round((data.objectDone / data.objectTotal) * 100);
        barObj.style.width = pct + '%';
        if (lblObj) { lblObj.textContent = data.objectDone + ' / ' + data.objectTotal; }
    }

    const barAll = document.getElementById('progress-bar-overall');
    const lblAll = document.getElementById('progress-label-overall');
    if (barAll && data.totalObjects > 0) {
        const pct = Math.round((data.objectsCompleted / data.totalObjects) * 100);
        barAll.style.width = pct + '%';
        if (lblAll) { lblAll.textContent = 'Overall: ' + data.objectsCompleted + ' / ' + data.totalObjects; }
    }
}

function appendLog(text, level) {
    const area = document.getElementById('log-area');
    if (!area) { return; }
    const div = document.createElement('div');
    div.className = 'log-line ' + (level || '');
    div.textContent = text;
    area.appendChild(div);
    // Cap at 2000 lines
    while (area.childElementCount > 2000) { area.removeChild(area.firstChild); }
    area.scrollTop = area.scrollHeight;
}

function handleRunDone(msg) {
    stopElapsedTimer();
    const banner = document.getElementById('run-banner');
    if (banner) { banner.textContent = '✅ ' + (msg.op || '') + (msg.dryRun ? ' (dry run)' : '') + ' complete'; banner.style.background = '#4CAF50'; banner.style.color = '#000'; }
}

function handleRunError(message) {
    stopElapsedTimer();
    const banner = document.getElementById('run-banner');
    if (banner) { banner.textContent = '❌ Error: ' + message; banner.style.background = '#F44336'; banner.style.color = '#fff'; }
    appendLog('ERROR: ' + message, 'error');
}

window.addEventListener('message', function(event) {
    const msg = event.data;
    if (msg.command === 'logLine')  { appendLog(msg.text, msg.level); }
    if (msg.command === 'progress') { updateProgress(msg.data); }
    if (msg.command === 'runDone')  { handleRunDone(msg); }
    if (msg.command === 'runError') { handleRunError(msg.message); }
});

// Auto-scroll log on load
(function() {
    const area = document.getElementById('log-area');
    if (area) { area.scrollTop = area.scrollHeight; }
})();

// Expose to onclick handlers
window.send              = send;
window.startPull         = startPull;
window.startLoad         = startLoad;
window.startPullAndLoad  = startPullAndLoad;
window.saveSettings      = saveSettings;
window.moveObj           = moveObj;
window.saveOrder         = saveOrder;
window.openInlineEditor  = openInlineEditor;
window.closeInlineEditor = closeInlineEditor;
window.saveInlineEditor  = saveInlineEditor;
window.openAddObjectModal  = openAddObjectModal;
window.closeAddObjectModal = closeAddObjectModal;
window.submitAddObject     = submitAddObject;
window.pendingSettings     = pendingSettings;

})();
</script>
</body>
</html>`;
    }
}
