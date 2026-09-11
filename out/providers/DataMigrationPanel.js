"use strict";
// DataMigrationPanel.ts — 4-tab VS Code webview panel for Salesforce Data Migration.
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
exports.DataMigrationPanel = void 0;
const vscode = __importStar(require("vscode"));
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
const shared_1 = require("../ui/shared");
const RoleManager_1 = require("../RoleManager");
const config_1 = require("../config");
const DataMigrationConfig_1 = require("../DataMigrationConfig");
const DataMigrationEngine_1 = require("../DataMigrationEngine");
const Log_1 = require("../Log");
// ── helpers ──────────────────────────────────────────────────────────────────
/** Count records in one object's seed file. Pull writes exactly `{sobject}.json` (single file,
 *  exact name — see pullData) since the redesign dropped the old multi-file `sf data export
 *  tree --plan` format, so this must match the filename exactly. A substring match here would
 *  silently double-count (e.g. "Account" matching "AccountTeamMember.json" too) and previously
 *  did — that's exactly the kind of thing that makes the Tracking/Pull tab counts look wrong. */
function countSeedRecords(seedDir, sobject) {
    const fp = path.join(seedDir, `${sobject}.json`);
    if (!fs.existsSync(fp)) {
        return 0;
    }
    try {
        const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
        return Array.isArray(data.records) ? data.records.length : 0;
    }
    catch {
        return 0;
    }
}
/** Read last-pull timestamp and per-object record counts from seed directory. */
function getSeedInfo(workspaceRoot, config) {
    const seedDir = path.resolve(workspaceRoot, config.seedDir);
    const planPath = path.join(seedDir, "plan.json");
    let lastPulled = null;
    try {
        const p = JSON.parse(fs.readFileSync(planPath, "utf-8"));
        lastPulled = p.generatedAt ?? null;
    }
    catch { /* ignore */ }
    return (config.objects ?? []).filter(o => o.active !== false).map(obj => ({
        sobject: obj.sobject,
        label: obj.label || obj.sobject,
        count: countSeedRecords(seedDir, obj.sobject),
        lastPulled,
    }));
}
function esc(s) {
    return String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
}
function jsonInject(data) {
    return JSON.stringify(data)
        .replace(/</g, "\\u003c")
        .replace(/>/g, "\\u003e")
        .replace(/&/g, "\\u0026");
}
// ── panel ────────────────────────────────────────────────────────────────────
class DataMigrationPanel {
    // ── static entry point ───────────────────────────────────────────────────
    static createOrShow(context, workspaceRoot) {
        // Role gate
        const role = (0, RoleManager_1.getEffectiveRole)(context);
        const roles = (0, config_1.getRoles)();
        const leadIdx = roles.findIndex((r) => r.toLowerCase() === "lead");
        const userIdx = roles.findIndex((r) => r === role);
        if (DataMigrationPanel._current) {
            DataMigrationPanel._current._panel.reveal(vscode.ViewColumn.Two);
            DataMigrationPanel._current._refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel("sfDevopsDataMigration", "Salesforce-DevOps — Data Migration", vscode.ViewColumn.Two, { enableScripts: true, retainContextWhenHidden: true });
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
    constructor(_panel, _ctx, _workspaceRoot) {
        this._panel = _panel;
        this._ctx = _ctx;
        this._workspaceRoot = _workspaceRoot;
        this._disposables = [];
        this._refreshing = false;
        this._config = { objects: [], batchSize: 190, seedDir: ".git/sf-devops-dm/seed" };
        this._activeTab = "config";
        this._pullState = "idle";
        this._loadState = "idle";
        this._pullLog = [];
        this._loadLog = [];
        this._dryRunMode = false;
        this._trackingViewOrg = "";
        // Covers operations with no pull/load state machine of their own (ExternalId check/create,
        // auto-sort) — used together with pull/load state to lock the UI against overlapping runs.
        this._extBusy = false;
        this._extBusyLabel = "";
        // Last operation error, shown in a banner that's visible on every tab until dismissed or a
        // new run starts — unlike a one-shot postMessage, it survives the _refresh() that follows.
        this._lastError = null;
        this._availableOrgs = [];
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        // Commands that must never overlap a running pull/load/rollback/ExternalId/auto-sort
        // operation — buttons are disabled client-side while busy, but this is the server-side
        // backstop against a stale render or a message that was already in flight.
        const EXCLUSIVE_COMMANDS = new Set([
            "pull", "load", "pullAndLoad", "rollback", "autoSort",
            "checkExtId", "checkAllExtIds",
            "retryFailed", "clearAndReload", "clearAllAndReload",
        ]);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (EXCLUSIVE_COMMANDS.has(msg.command) && this._anyRunning) {
                vscode.window.showWarningMessage(`Please wait for "${this._busyLabel}" to finish first.`);
                return;
            }
            try {
                switch (msg.command) {
                    case "switchTab":
                        this._activeTab = msg.tab;
                        this._refresh();
                        break;
                    case "refresh":
                        this._refresh();
                        break;
                    case "dismissError":
                        this._lastError = null;
                        this._refresh();
                        break;
                    case "saveConfig": {
                        const incomingConfig = msg.config;
                        const resolvedSeedDir = path.resolve(this._workspaceRoot, incomingConfig.seedDir || "");
                        if (!resolvedSeedDir.startsWith(this._workspaceRoot)) {
                            this._panel.webview.postMessage({ command: "logLine", text: "Invalid seedDir: must be inside the workspace.", level: "error" });
                            break;
                        }
                        (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, incomingConfig);
                        this._config = incomingConfig;
                        this._refresh();
                        break;
                    }
                    case "addObject": {
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                        cfg.objects.push(msg.obj);
                        (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, cfg);
                        this._config = cfg;
                        this._refresh();
                        break;
                    }
                    case "updateObject": {
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                        const idx = cfg.objects.findIndex((o) => o.id === msg.obj.id);
                        if (idx !== -1) {
                            cfg.objects[idx] = msg.obj;
                        }
                        (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, cfg);
                        this._config = cfg;
                        this._refresh();
                        break;
                    }
                    case "deleteObject": {
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                        cfg.objects = cfg.objects.filter((o) => o.id !== msg.id);
                        (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, cfg);
                        this._config = cfg;
                        this._refresh();
                        break;
                    }
                    case "reorderObjects": {
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                        const ids = msg.ids;
                        cfg.objects = ids.map((id) => cfg.objects.find((o) => o.id === id)).filter(Boolean);
                        (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, cfg);
                        this._config = cfg;
                        this._refresh();
                        break;
                    }
                    case "autoSort": {
                        if (!msg.targetOrg) {
                            this._panel.webview.postMessage({ command: "logLine", text: "Select a target org before auto-sorting.", level: "warn" });
                            break;
                        }
                        await this._runExtBusy("Auto-sorting…", async () => {
                            let cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                            cfg = await (0, DataMigrationEngine_1.autoSortByDependencies)(msg.targetOrg, this._workspaceRoot, cfg, () => { });
                            (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, cfg);
                            this._config = cfg;
                        });
                        break;
                    }
                    case "setSourceOrg":
                        (0, DataMigrationConfig_1.setSourceOrg)(this._ctx, msg.alias);
                        this._refresh();
                        break;
                    case "setTargetOrg":
                        (0, DataMigrationConfig_1.setTargetOrg)(this._ctx, msg.alias);
                        this._trackingCache = undefined;
                        this._refresh();
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
                        this._loadController?.pause();
                        this._loadState = "paused";
                        break;
                    case "resume":
                        this._loadController?.resume();
                        this._loadState = "running";
                        break;
                    case "skipObject":
                        this._loadController?.skipObject();
                        break;
                    case "cancel":
                        this._loadController?.cancel();
                        this._pullController?.cancel();
                        this._loadState = "idle";
                        this._pullState = "idle";
                        break;
                    case "cancelPull":
                        this._pullController?.cancel();
                        this._pullState = "idle";
                        break;
                    case "selectTrackingOrg":
                        this._trackingViewOrg = msg.org || "";
                        this._trackingCache = undefined;
                        this._refresh();
                        break;
                    case "refreshTracking":
                        this._trackingCache = undefined;
                        this._refresh();
                        break;
                    case "clearAndReload": {
                        const trk = (0, DataMigrationConfig_1.readTracking)(this._workspaceRoot, msg.targetOrg);
                        delete trk[msg.sobject];
                        (0, DataMigrationConfig_1.writeTracking)(this._workspaceRoot, msg.targetOrg, trk);
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                        this._config = cfg;
                        await this._startLoad(msg.targetOrg, false, msg.sobject);
                        break;
                    }
                    case "clearAllAndReload": {
                        const ok = await vscode.window.showWarningMessage(`Clear all tracking for ${msg.targetOrg} and reload every object?`, { modal: true }, "Clear & Reload");
                        if (ok !== "Clear & Reload") {
                            break;
                        }
                        (0, DataMigrationConfig_1.writeTracking)(this._workspaceRoot, msg.targetOrg, {});
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                        this._config = cfg;
                        await this._startLoad(msg.targetOrg, false);
                        break;
                    }
                    case "clearSeed": {
                        // Exact filename only — a substring match here (e.g. "Account" matching
                        // "AccountTeamMember.json") would delete an unrelated object's seed data too.
                        const seedDir = path.resolve(this._workspaceRoot, this._config.seedDir);
                        const seedFile = path.join(seedDir, `${msg.sobject}.json`);
                        if (fs.existsSync(seedFile)) {
                            try {
                                fs.unlinkSync(seedFile);
                            }
                            catch { /* ignore */ }
                        }
                        this._refresh();
                        break;
                    }
                    case "viewPullLog": {
                        const dir = (0, DataMigrationConfig_1.pullLogsDir)(this._workspaceRoot);
                        const recent = (0, DataMigrationConfig_1.listRecentLogs)(dir, 1);
                        const fp = recent[0] ? path.join(dir, recent[0]) : null;
                        if (!fp || !fs.existsSync(fp)) {
                            vscode.window.showWarningMessage("No pull log found.");
                            break;
                        }
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fp), vscode.ViewColumn.One);
                        break;
                    }
                    case "viewLoadLog": {
                        const dir = (0, DataMigrationConfig_1.loadLogsDir)(this._workspaceRoot, msg.targetOrg || "");
                        const recent = (0, DataMigrationConfig_1.listRecentLogs)(dir, 1);
                        const fp = recent[0] ? path.join(dir, recent[0]) : null;
                        if (!fp || !fs.existsSync(fp)) {
                            vscode.window.showWarningMessage("No load log found for this org.");
                            break;
                        }
                        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(fp), vscode.ViewColumn.One);
                        break;
                    }
                    case "retryFailed": {
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
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
                    case "refreshOrgs": {
                        this._panel.webview.postMessage({ command: "logLine", text: "Refreshing org list...", level: "info" });
                        (0, DataMigrationEngine_1.listAvailableOrgs)(this._workspaceRoot)
                            .then(orgs => { this._availableOrgs = orgs; this._refresh(); })
                            .catch(err => { this._reportError(`Failed to refresh org list: ${String(err)}`); this._refresh(); });
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
                        if (!fs.existsSync(cfgPath)) {
                            (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, this._config);
                        }
                        const doc = await vscode.workspace.openTextDocument(cfgPath);
                        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                        break;
                    }
                    case "reconcileTracking": {
                        const rOrg = msg.targetOrg;
                        if (!rOrg) {
                            vscode.window.showWarningMessage("Select a target org first.");
                            break;
                        }
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                        await this._runExtBusy("Reconciling tracking…", async () => {
                            const postLog = (text, level) => {
                                const line = `[${new Date().toLocaleTimeString()}]  ${text}`;
                                this._loadLog.push({ text: line, level });
                                this._panel.webview.postMessage({ command: "logLine", text: line, level });
                                (0, Log_1.log)(`[DM reconcile] ${text}`);
                            };
                            postLog(`Reconciling tracking for ${rOrg} — querying target org…`, "info");
                            this._activeTab = "load";
                            const result = await (0, DataMigrationEngine_1.reconcileTracking)(rOrg, this._workspaceRoot, cfg, null, postLog);
                            vscode.window.showInformationMessage(`Reconcile done: ${result.fixed} record(s) corrected, ${result.stillFailed} still failed.`);
                            this._trackingCache = undefined;
                        });
                        break;
                    }
                    case "validateMigration": {
                        const vOrg = msg.targetOrg;
                        if (!vOrg) {
                            vscode.window.showWarningMessage("Select a target org first.");
                            break;
                        }
                        const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
                        await this._runExtBusy("Validating migration…", async () => {
                            const postLog = (text, level) => {
                                const line = `[${new Date().toLocaleTimeString()}]  ${text}`;
                                this._loadLog.push({ text: line, level });
                                this._panel.webview.postMessage({ command: "logLine", text: line, level });
                                (0, Log_1.log)(`[DM validate] ${text}`);
                            };
                            this._activeTab = "load";
                            const report = await (0, DataMigrationEngine_1.validateMigration)(vOrg, this._workspaceRoot, cfg, postLog);
                            const matched = report.totalMatched;
                            const total = report.objects.length;
                            vscode.window.showInformationMessage(`Validation: ${matched}/${total} objects matched in target org.`);
                            // Write validation log
                            const vLogDir = path.join((0, DataMigrationConfig_1.dmBaseDir)(this._workspaceRoot), "logs", "validation", (0, DataMigrationConfig_1.safeOrgName)(vOrg));
                            (0, DataMigrationConfig_1.writeJobLog)(vLogDir, this._loadLog.slice(-200).map(l => `[${l.level.toUpperCase()}] ${l.text}`));
                            this._trackingCache = undefined;
                        });
                        break;
                    }
                    case "viewErrors": {
                        const veOrg = msg.targetOrg;
                        const veSobject = msg.sobject;
                        if (!veOrg || !veSobject) {
                            break;
                        }
                        const trk = (0, DataMigrationConfig_1.readTracking)(this._workspaceRoot, veOrg);
                        const failed = Object.entries(trk[veSobject] ?? {})
                            .filter(([, e]) => e.status === "failed");
                        if (failed.length === 0) {
                            vscode.window.showInformationMessage(`No failed records for ${veSobject}.`);
                            break;
                        }
                        // Show errors in a new untitled document for easy scrolling/search
                        const lines = [
                            `Failed records for ${veSobject} on ${veOrg} (${failed.length} total)`,
                            "=".repeat(60),
                            "",
                            ...failed.map(([srcId, e]) => `Source ID : ${srcId}\nError     : ${e.error ?? "unknown"}\nAt        : ${e.at ?? ""}\n`),
                        ];
                        const doc = await vscode.workspace.openTextDocument({
                            language: "plaintext",
                            content: lines.join("\n"),
                        });
                        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
                        break;
                    }
                }
            }
            catch (err) {
                // Safety net: any handler above that doesn't already catch its own errors
                // (e.g. a malformed .sf-devops-dm.json on a plain config edit) would otherwise
                // fail as a silent, invisible unhandled rejection.
                this._reportError(`Action "${msg.command}" failed: ${String(err)}`);
            }
        }, null, this._disposables);
        this._panel.webview.html = (0, shared_1.loadingHtml)("Loading Data Migration...");
        // Load available orgs once, non-blocking — cached for the lifetime of the panel
        (0, DataMigrationEngine_1.listAvailableOrgs)(this._workspaceRoot)
            .then(orgs => { this._availableOrgs = orgs; })
            .catch(() => { })
            .finally(() => this._refresh());
        // Watch .sf-devops-dm.json so external edits (e.g. via "Edit Raw JSON") auto-refresh
        const configPattern = new vscode.RelativePattern(this._workspaceRoot, ".sf-devops-dm.json");
        const cfgWatcher = vscode.workspace.createFileSystemWatcher(configPattern, true, false, true);
        cfgWatcher.onDidChange(() => {
            try {
                this._config = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
            }
            catch { /* ignore parse errors */ }
            this._refresh();
        }, null, this._disposables);
        this._disposables.push(cfgWatcher);
    }
    /** True whenever ANY long-running operation is in flight — pull, load (including paused),
     *  rollback (which reuses the load state machine), an ExternalId check/create, or auto-sort.
     *  Drives both the global busy banner and disabling of mutating buttons across every tab. */
    get _anyRunning() {
        return this._pullState === "running"
            || this._loadState === "running"
            || this._loadState === "paused"
            || this._extBusy;
    }
    get _busyLabel() {
        if (this._pullState === "running") {
            return "Pulling…";
        }
        if (this._loadState === "running") {
            return this._dryRunMode ? "Dry run…" : "Loading…";
        }
        if (this._loadState === "paused") {
            return "Load paused";
        }
        if (this._extBusy) {
            return this._extBusyLabel;
        }
        return "";
    }
    /** Runs an operation that has no dedicated state machine (ExternalId check/create, auto-sort)
     *  behind the same busy lock as pull/load, so its buttons disable everywhere and it can't
     *  overlap with a pull/load/rollback. Errors are surfaced both as a native notification and
     *  in the panel's global error banner — never silently swallowed. */
    async _runExtBusy(label, fn) {
        if (this._anyRunning) {
            vscode.window.showWarningMessage(`Please wait for "${this._busyLabel}" to finish first.`);
            return;
        }
        this._extBusy = true;
        this._extBusyLabel = label;
        this._lastError = null;
        this._refresh();
        try {
            await fn();
        }
        catch (err) {
            this._reportError(`${label} failed: ${String(err)}`);
        }
        finally {
            this._extBusy = false;
            this._extBusyLabel = "";
            this._refresh();
        }
    }
    _dispose() {
        DataMigrationPanel._current = undefined;
        this._panel.dispose();
        while (this._disposables.length) {
            this._disposables.pop()?.dispose();
        }
    }
    // ── refresh ──────────────────────────────────────────────────────────────
    _refresh() {
        if (this._refreshing) {
            return;
        }
        this._refreshing = true;
        try {
            const vm = this._buildViewModel();
            this._panel.webview.html = this._renderHtml(vm);
        }
        catch (err) {
            this._panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">Error: ${esc(String(err))}</body>`;
        }
        finally {
            this._refreshing = false;
        }
    }
    // ── view model ───────────────────────────────────────────────────────────
    _buildViewModel() {
        const config = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
        this._config = config;
        const sourceOrg = (0, DataMigrationConfig_1.getSourceOrg)(this._ctx) || "";
        const targetOrg = (0, DataMigrationConfig_1.getTargetOrg)(this._ctx) || "";
        const role = (0, RoleManager_1.getEffectiveRole)(this._ctx);
        const envs = (0, config_1.getEnvironments)();
        const trackingOrg = this._trackingViewOrg || targetOrg;
        let tracking = {};
        if (trackingOrg) {
            if (!this._trackingCache || this._trackingCache.org !== trackingOrg) {
                this._trackingCache = { org: trackingOrg, data: (0, DataMigrationConfig_1.readTracking)(this._workspaceRoot, trackingOrg) };
            }
            tracking = this._trackingCache.data;
        }
        const hasLog = fs.existsSync((0, DataMigrationConfig_1.lastRunLogPath)(this._workspaceRoot));
        const seedInfo = getSeedInfo(this._workspaceRoot, config);
        // List all orgs that have tracking files (for the Tracking org selector)
        const trackingDir = path.join(this._workspaceRoot, ".git", "sf-devops-dm", "tracking");
        const trackedOrgs = fs.existsSync(trackingDir)
            ? fs.readdirSync(trackingDir).filter(f => f.endsWith(".json")).map(f => f.replace(/\.json$/, ""))
            : [];
        return {
            config,
            sourceOrg,
            targetOrg,
            role,
            envs,
            tracking,
            trackingOrg,
            trackedOrgs,
            hasLog,
            seedInfo,
            availableOrgs: this._availableOrgs,
            pullState: this._pullState,
            loadState: this._loadState,
            activeTab: this._activeTab,
            dryRun: this._dryRunMode,
            pullLog: this._pullLog,
            loadLog: this._loadLog,
            busy: this._anyRunning,
            busyLabel: this._busyLabel,
            lastError: this._lastError,
        };
    }
    // ── operations ───────────────────────────────────────────────────────────
    /** Surface a failure both as a native VS Code notification (visible no matter which tab is
     *  open, or even if the panel isn't focused) and in the panel's own error banner. */
    _reportError(message) {
        this._lastError = message;
        vscode.window.showErrorMessage(message);
        this._panel.webview.postMessage({ command: "runError", message });
    }
    _makeLogHandlers(logTarget) {
        const onLog = (text, level) => {
            const line = `[${new Date().toLocaleTimeString()}]  ${text}`;
            logTarget.push({ text: line, level });
            if (logTarget.length > 2000) {
                logTarget.shift();
            }
            this._panel.webview.postMessage({ command: "logLine", text: line, level });
            (0, Log_1.log)(`[DM] ${text}`);
        };
        const onProgress = (evt) => {
            this._panel.webview.postMessage({ command: "progress", data: evt });
        };
        return { onLog, onProgress };
    }
    async _startPull(sourceOrg, dryRun) {
        this._pullState = "running";
        this._lastError = null;
        this._pullLog = [];
        this._dryRunMode = dryRun;
        this._activeTab = "pull";
        const ctrl = (0, DataMigrationEngine_1.makeController)();
        this._pullController = ctrl;
        const { onLog, onProgress } = this._makeLogHandlers(this._pullLog);
        this._refresh();
        try {
            await (0, DataMigrationEngine_1.pullData)(sourceOrg, this._workspaceRoot, this._config, onLog, onProgress, ctrl, { dryRun, dryRunSampleSize: 5 });
            if (!dryRun) {
                (0, DataMigrationConfig_1.writeJobLog)((0, DataMigrationConfig_1.pullLogsDir)(this._workspaceRoot), this._pullLog.map(l => `[${l.level}] ${l.text}`));
            }
            this._panel.webview.postMessage({ command: "runDone", op: "pull", dryRun });
        }
        catch (err) {
            this._reportError(`Pull failed: ${String(err)}`);
        }
        finally {
            this._pullState = "done";
            this._pullController = undefined;
            this._refresh();
        }
    }
    async _startLoad(targetOrg, dryRun, sobject) {
        this._loadState = "running";
        this._lastError = null;
        this._loadLog = [];
        this._dryRunMode = dryRun;
        this._activeTab = "load";
        const ctrl = (0, DataMigrationEngine_1.makeController)();
        this._loadController = ctrl;
        const { onLog, onProgress } = this._makeLogHandlers(this._loadLog);
        this._refresh();
        try {
            await (0, DataMigrationEngine_1.loadData)(targetOrg, this._workspaceRoot, this._config, onLog, onProgress, ctrl, { dryRun, objectFilter: sobject ? [sobject] : undefined });
            if (!dryRun) {
                try {
                    const report = await (0, DataMigrationEngine_1.validateMigration)(targetOrg, this._workspaceRoot, this._config, onLog);
                    // Auto-reconcile if validation found discrepancies — this corrects stale "failed"
                    // tracking entries for records that actually landed in the target org.
                    if (report.totalDiscrepancies > 0) {
                        onLog(`Auto-reconciling ${report.totalDiscrepancies} object(s) with discrepancies…`, "info");
                        await (0, DataMigrationEngine_1.reconcileTracking)(targetOrg, this._workspaceRoot, this._config, null, onLog);
                        this._trackingCache = undefined;
                    }
                }
                catch { /* validation/reconcile failure should not block load completion */ }
                (0, DataMigrationConfig_1.writeJobLog)((0, DataMigrationConfig_1.loadLogsDir)(this._workspaceRoot, targetOrg), this._loadLog.map(l => `[${l.level}] ${l.text}`));
            }
            this._panel.webview.postMessage({ command: "runDone", op: "load", dryRun });
        }
        catch (err) {
            this._reportError(`Load failed: ${String(err)}`);
        }
        finally {
            this._loadState = "done";
            this._loadController = undefined;
            this._trackingCache = undefined;
            this._refresh();
        }
    }
    async _startPullAndLoad(sourceOrg, targetOrg, dryRun) {
        // Pull phase
        this._pullState = "running";
        this._lastError = null;
        this._pullLog = [];
        this._activeTab = "pull";
        this._dryRunMode = dryRun;
        const pullCtrl = (0, DataMigrationEngine_1.makeController)();
        this._pullController = pullCtrl;
        // _loadController intentionally NOT set here — keeps skipObject from leaking into load phase
        const { onLog: pullLog, onProgress: pullProg } = this._makeLogHandlers(this._pullLog);
        this._refresh();
        let loadActuallyRan = false;
        try {
            await (0, DataMigrationEngine_1.pullData)(sourceOrg, this._workspaceRoot, this._config, pullLog, pullProg, pullCtrl, { dryRun, dryRunSampleSize: 5 });
            if (!dryRun) {
                (0, DataMigrationConfig_1.writeJobLog)((0, DataMigrationConfig_1.pullLogsDir)(this._workspaceRoot), this._pullLog.map(l => `[${l.level}] ${l.text}`));
            }
            this._pullState = "done";
            if (pullCtrl.state !== "cancelled") {
                // Load phase — use a fresh controller so pull-phase skip/pause state doesn't bleed in
                const loadCtrl = (0, DataMigrationEngine_1.makeController)();
                this._loadController = loadCtrl;
                loadActuallyRan = true;
                this._loadState = "running";
                this._loadLog = [];
                this._activeTab = "load";
                const { onLog: loadLog, onProgress: loadProg } = this._makeLogHandlers(this._loadLog);
                this._refresh();
                await (0, DataMigrationEngine_1.loadData)(targetOrg, this._workspaceRoot, this._config, loadLog, loadProg, loadCtrl, { dryRun });
                if (!dryRun) {
                    try {
                        const report = await (0, DataMigrationEngine_1.validateMigration)(targetOrg, this._workspaceRoot, this._config, loadLog);
                        if (report.totalDiscrepancies > 0) {
                            loadLog(`Auto-reconciling ${report.totalDiscrepancies} object(s) with discrepancies…`, "info");
                            await (0, DataMigrationEngine_1.reconcileTracking)(targetOrg, this._workspaceRoot, this._config, null, loadLog);
                            this._trackingCache = undefined;
                        }
                    }
                    catch { /* validation/reconcile failure should not block completion */ }
                    (0, DataMigrationConfig_1.writeJobLog)((0, DataMigrationConfig_1.loadLogsDir)(this._workspaceRoot, targetOrg), this._loadLog.map(l => `[${l.level}] ${l.text}`));
                }
            }
            this._panel.webview.postMessage({ command: "runDone", op: "pullAndLoad", dryRun });
        }
        catch (err) {
            this._reportError(`Pull + Load failed: ${String(err)}`);
        }
        finally {
            this._pullState = this._pullState === "running" ? "done" : this._pullState;
            // Only mark load as done if load actually ran; if pull was cancelled before load, reset to idle
            if (loadActuallyRan) {
                this._loadState = this._loadState === "running" ? "done" : this._loadState;
            }
            else {
                this._loadState = "idle";
            }
            this._pullController = undefined;
            this._loadController = undefined;
            this._trackingCache = undefined;
            this._refresh();
        }
    }
    async _handleRollback(targetOrg, dryRun) {
        const confirm = await vscode.window.showWarningMessage(`This will delete all tracked records from ${targetOrg}. Type DELETE to confirm.`, { modal: true }, "DELETE");
        if (confirm !== "DELETE") {
            return;
        }
        this._loadState = "running";
        this._lastError = null;
        this._loadLog = [];
        this._activeTab = "load";
        const ctrl = (0, DataMigrationEngine_1.makeController)();
        this._loadController = ctrl;
        const { onLog, onProgress } = this._makeLogHandlers(this._loadLog);
        this._refresh();
        try {
            await (0, DataMigrationEngine_1.rollbackData)(targetOrg, this._workspaceRoot, this._config, onLog, { dryRun });
            this._panel.webview.postMessage({ command: "runDone", op: "rollback", dryRun });
        }
        catch (err) {
            this._reportError(`Rollback failed: ${String(err)}`);
        }
        finally {
            this._loadState = "done";
            this._loadController = undefined;
            this._trackingCache = undefined;
            this._refresh();
        }
    }
    async _handleClearObject(sobject, trackOrg) {
        // Clears the tracking entries only — does NOT delete records from Salesforce.
        // Use Full Rollback for that.
        const trk = (0, DataMigrationConfig_1.readTracking)(this._workspaceRoot, trackOrg);
        if (trk[sobject]) {
            delete trk[sobject];
            (0, DataMigrationConfig_1.writeTracking)(this._workspaceRoot, trackOrg, trk);
        }
        this._trackingCache = undefined;
        vscode.window.showInformationMessage(`Tracking cleared for ${sobject} in ${trackOrg}.`);
        this._refresh();
    }
    async _handleExportCsv(targetOrg) {
        try {
            const tracking = (0, DataMigrationConfig_1.readTracking)(this._workspaceRoot, targetOrg);
            const rows = ["Object,Total,Created,Failed,Skipped,Pending,Blocked"];
            for (const [obj, entries] of Object.entries(tracking)) {
                const counts = { created: 0, failed: 0, skipped: 0, pending: 0, blocked: 0 };
                for (const e of Object.values(entries)) {
                    if (e.status in counts) {
                        counts[e.status]++;
                    }
                    else {
                        counts.pending++;
                    }
                }
                const total = Object.keys(entries).length;
                rows.push([obj, total, counts.created, counts.failed, counts.skipped, counts.pending, counts.blocked].join(","));
            }
            const exportDir = path.join(this._workspaceRoot, ".git", "sf-devops-dm", "exports");
            fs.mkdirSync(exportDir, { recursive: true });
            const outPath = path.join(exportDir, `dm-tracking-${(0, DataMigrationConfig_1.safeOrgName)(targetOrg)}-${Date.now()}.csv`);
            fs.writeFileSync(outPath, rows.join("\n"), "utf8");
            const doc = await vscode.workspace.openTextDocument(outPath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
        }
    }
    async _handleViewLog() {
        const logPath = (0, DataMigrationConfig_1.lastRunLogPath)(this._workspaceRoot);
        if (!fs.existsSync(logPath)) {
            vscode.window.showWarningMessage("No log file found.");
            return;
        }
        const doc = await vscode.workspace.openTextDocument(logPath);
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
    }
    async _handleCheckExtId(sobject, targetOrg) {
        await this._runExtBusy(`Checking ExternalId for ${sobject}…`, async () => {
            const { onLog } = this._makeLogHandlers(this._loadLog);
            const fieldName = await (0, DataMigrationEngine_1.checkExternalId)(targetOrg, sobject, this._workspaceRoot, onLog);
            const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
            const obj = cfg.objects.find((o) => o.sobject === sobject);
            if (obj) {
                if (fieldName) {
                    obj.externalIdField = fieldName;
                }
                (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, cfg);
                this._config = cfg;
            }
            onLog(`External ID check for ${sobject}: ${fieldName ? "Found — " + fieldName : "Not found"}`, fieldName ? "success" : "warn");
        });
    }
    async _handleCheckAllExtIds(targetOrg) {
        await this._runExtBusy("Checking ExternalIds…", async () => {
            const { onLog } = this._makeLogHandlers(this._loadLog);
            const cfg = (0, DataMigrationConfig_1.readDmConfig)(this._workspaceRoot);
            const active = cfg.objects.filter((o) => o.active !== false);
            const chunkSize = 5;
            for (let i = 0; i < active.length; i += chunkSize) {
                const chunk = active.slice(i, i + chunkSize);
                await Promise.allSettled(chunk.map(async (obj) => {
                    try {
                        const fieldName = await (0, DataMigrationEngine_1.checkExternalId)(targetOrg, obj.sobject, this._workspaceRoot, onLog);
                        if (fieldName) {
                            obj.externalIdField = fieldName;
                        }
                        onLog(`${obj.sobject}: ${fieldName ? "✓ " + fieldName : "✗ not found"}`, fieldName ? "success" : "warn");
                    }
                    catch (err) {
                        onLog(`${obj.sobject}: check error — ${String(err)}`, "error");
                    }
                }));
            }
            (0, DataMigrationConfig_1.writeDmConfig)(this._workspaceRoot, cfg);
            this._config = cfg;
        });
    }
    async _handleExportDryRunReport() {
        try {
            const src = this._loadLog.length > 0 ? this._loadLog : this._pullLog;
            const lines = src.map(l => `[${l.level}] ${l.text}`);
            const exportDir = path.join(this._workspaceRoot, ".git", "sf-devops-dm", "exports");
            fs.mkdirSync(exportDir, { recursive: true });
            const outPath = path.join(exportDir, `dm-dryrun-report-${Date.now()}.log`);
            fs.writeFileSync(outPath, lines.join("\n"), "utf8");
            const doc = await vscode.workspace.openTextDocument(outPath);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
        }
        catch (err) {
            vscode.window.showErrorMessage(`Export failed: ${String(err)}`);
        }
    }
    // ── HTML rendering ───────────────────────────────────────────────────────
    static _accessDeniedHtml(webview, role, required) {
        return `<!DOCTYPE html><html><head>${(0, shared_1.cspMeta)(webview)}<style>
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
    _renderHtml(vm) {
        const { config, sourceOrg, targetOrg, role, envs, tracking, trackingOrg, trackedOrgs, hasLog, seedInfo, availableOrgs, pullState, loadState, activeTab, dryRun, pullLog, loadLog, busy, busyLabel, lastError } = vm;
        // Disable-attribute fragment for every button that mutates state or shells out to the
        // Salesforce CLI, so nothing can be started while another operation is already running.
        const dis = busy ? "disabled" : "";
        // Build pipeline orgs list
        const pipelineAliases = new Set();
        const envEntries = Object.entries(envs ?? {});
        const slotEntries = Object.entries((0, config_1.getOrgAliasSlots)?.() ?? {});
        for (const [, v] of [...envEntries, ...slotEntries]) {
            if (typeof v === "string" && v) {
                pipelineAliases.add(v);
            }
        }
        const pipelineOrgs = [...pipelineAliases].map((a) => ({ alias: a, username: a }));
        const otherOrgs = (availableOrgs || []).filter((o) => !pipelineAliases.has(o.alias));
        function orgOptions(selectedAlias) {
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
        const tabs = [
            { id: "config", label: "⚙ Config" },
            { id: "pull", label: "⬇ Pull" },
            { id: "load", label: `⬆ Load${loadState === "running" ? " ●" : loadState === "paused" ? " ⏸" : ""}` },
            { id: "tracking", label: "📊 Tracking" },
            { id: "extids", label: "🔑 External IDs" },
        ];
        // ── Tab 1: Config ────────────────────────────────────────────────────
        const renderConfigTab = () => {
            const objects = config.objects ?? [];
            let rows = "";
            objects.forEach((obj, idx) => {
                const active = obj.active !== false;
                const extIdBadge = obj.externalIdField
                    ? `<span class="badge badge-green" title="${esc(obj.externalIdField)}">✅ ${esc(obj.externalIdField)}</span>`
                    : `<span class="badge badge-amber" style="cursor:pointer" onclick="send('switchTab',{tab:'extids'})">⚠️ Not set</span>`;
                const queryPreview = (obj.query || "").length > 60 ? esc(obj.query.slice(0, 60)) + "…" : esc(obj.query ?? "");
                rows += `
                <tr id="row-${esc(obj.id)}" class="${active ? "" : "inactive-row"}">
                    <td>${idx + 1}</td>
                    <td><code>${esc(obj.sobject)}</code></td>
                    <td>${esc(obj.label ?? obj.sobject)}</td>
                    <td>${esc((obj.dependsOn ?? []).join(", "))}</td>
                    <td title="${esc(obj.query ?? "")}">${queryPreview}</td>
                    <td><label class="toggle-sw"><input type="checkbox" ${active ? "checked" : ""} ${dis} onchange="send('updateObject',{obj:Object.assign({},DATA.config.objects[${idx}],{active:this.checked})})"><span class="slider"></span></label></td>
                    <td>${extIdBadge}</td>
                    <td class="row-actions">
                        <button class="icon-btn" title="Edit" ${dis} onclick="openInlineEditor(${idx})">✏️</button>
                        <button class="icon-btn" title="Move Up" onclick="moveObj(${idx},-1)" ${idx === 0 || busy ? "disabled" : ""}>▲</button>
                        <button class="icon-btn" title="Move Down" onclick="moveObj(${idx},1)" ${idx === objects.length - 1 || busy ? "disabled" : ""}>▼</button>
                        <button class="icon-btn danger-btn" title="Delete" ${dis} onclick="if(confirm('Delete '+${esc(JSON.stringify(esc(obj.sobject)))}+'?'))send('deleteObject',{id:${esc(JSON.stringify(obj.id))}})">🗑</button>
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
                                <button class="btn btn-primary" ${dis} onclick="saveInlineEditor(${idx})">Save</button>
                                <button class="btn" onclick="closeInlineEditor('${esc(obj.id)}')">Cancel</button>
                            </div>
                        </div>
                    </td>
                </tr>`;
            });
            return `
            <div class="settings-card">
                <h3>Settings</h3>
                <div class="field-row">
                    <label>Batch size</label>
                    <input type="number" id="batchSize" value="${esc(String(config.batchSize ?? 190))}" min="1" max="10000" style="width:90px;flex:none" ${dis} oninput="pendingSettings.batchSize=+this.value" />
                </div>
                <div style="margin-top:12px">
                    <button class="btn btn-primary" ${dis} onclick="saveSettings()">Save Settings</button>
                </div>
            </div>

            <div class="toolbar" style="margin-top:16px">
                <button class="btn btn-primary" ${dis} onclick="openAddObjectModal()">+ Add Object</button>
                <button class="btn" ${dis} onclick="send('autoSort',{targetOrg:document.getElementById('sortTargetOrg').value})">Auto-Sort by Dependencies</button>
                <button class="btn" ${dis} onclick="saveOrder()">Save Order</button>
                <button class="btn" ${dis} onclick="send('openConfigJson',{})" title="Open .sf-devops-dm.json in editor — changes auto-refresh this panel on save">&#128196; Edit Raw JSON</button>
                <select id="sortTargetOrg" class="select" style="margin-left:auto" ${dis}>
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
                        <button class="btn btn-primary" ${dis} onclick="submitAddObject()">Add</button>
                        <button class="btn" onclick="closeAddObjectModal()">Cancel</button>
                    </div>
                </div>
            </div>`;
        };
        // ── Tab 2: Pull ──────────────────────────────────────────────────────
        const renderPullTab = () => {
            const isRunning = pullState === "running";
            const isDone = pullState === "done";
            const totalSeed = seedInfo.reduce((s, r) => s + r.count, 0);
            const hasSeed = totalSeed > 0;
            const seedRows = seedInfo.map(r => `<tr>
                <td><code>${esc(r.sobject)}</code></td>
                <td><strong>${r.count > 0 ? r.count : "—"}</strong></td>
                <td style="color:var(--vscode-descriptionForeground);font-size:11px">${r.lastPulled ? new Date(r.lastPulled).toLocaleString() : "—"}</td>
                <td class="row-actions">
                    ${r.count > 0 ? `<button class="btn btn-sm danger-btn" ${dis} onclick="if(confirm('Clear seed for ${esc(r.sobject)}?'))send('clearSeed',{sobject:${esc(JSON.stringify(r.sobject))}})">Clear</button>` : ""}
                </td>
            </tr>`).join("");
            const recentLogs = (0, DataMigrationConfig_1.listRecentLogs)((0, DataMigrationConfig_1.pullLogsDir)(this._workspaceRoot), 3);
            return `
            <div class="run-idle-card" style="max-width:680px">
                <div class="field-row" style="margin-bottom:12px">
                    <label style="width:100px">Source Org</label>
                    <select id="pullSourceOrg" class="select" ${dis} onchange="if(this.value==='**connect**')send('openConnectOrg');else send('setSourceOrg',{alias:this.value})">
                        ${orgOptions(sourceOrg)}
                    </select>
                    <button class="icon-btn" ${dis} onclick="send('refreshOrgs')" title="Refresh orgs">🔄</button>
                </div>
                <div class="toggle-row" style="margin-bottom:16px">
                    <label class="toggle-sw"><input type="checkbox" id="dryRunToggle" ${dryRun ? "checked" : ""} ${dis}><span class="slider"></span></label>
                    <span class="toggle-label">Dry Run — fetch 5 records per object, no files written</span>
                </div>
                <div class="toolbar" style="margin-bottom:12px">
                    ${isRunning
                ? `<button class="btn danger-btn" onclick="send('cancelPull')">✕ Cancel Pull</button>`
                : `<button class="btn btn-primary" ${dis} onclick="startPull()">⬇ Pull All Objects</button>`}
                    ${recentLogs.length > 0 ? `<button class="btn" onclick="send('viewPullLog',{})" style="margin-left:auto">📄 Last Pull Log</button>` : ""}
                </div>
                ${isRunning ? `<div class="run-banner banner-teal" id="run-banner" style="margin-bottom:12px">
                    <span>Pulling…</span><span style="flex:1"></span><span id="run-elapsed">00:00</span>
                </div>` : ""}
                ${isDone && !isRunning ? `<div class="done-banner">✅ Pull complete — ${totalSeed} total records in seed.</div>` : ""}
            </div>

            <h3 style="margin:20px 0 8px;font-size:13px">Seed Status${hasSeed ? ` — ${totalSeed} records total` : ""}</h3>
            ${seedInfo.length === 0
                ? `<p style="color:var(--vscode-descriptionForeground)">No active objects configured. Add objects in the Config tab.</p>`
                : `<div class="table-wrap"><table class="data-table">
                    <thead><tr><th>Object</th><th>Records in Seed</th><th>Last Pulled</th><th>Actions</th></tr></thead>
                    <tbody>${seedRows}</tbody>
                </table></div>`}

            <div class="log-area" id="log-area" style="margin-top:16px">${pullLog.map((l) => `<div class="log-line ${l.level}">${esc(l.text)}</div>`).join("")}</div>`;
        };
        // ── Tab 3: Load ──────────────────────────────────────────────────────
        const renderLoadTab = () => {
            const isActive = loadState === "running" || loadState === "paused";
            const isDone = loadState === "done";
            const recentLogs = (0, DataMigrationConfig_1.listRecentLogs)((0, DataMigrationConfig_1.loadLogsDir)(this._workspaceRoot, targetOrg), 3);
            if (isActive) {
                const bannerClass = dryRun ? "banner-amber" : "banner-teal";
                const bannerLabel = dryRun ? "DRY RUN" : "LOADING";
                return `
                <div class="run-banner ${bannerClass}" id="run-banner">
                    <span id="run-op-label">${bannerLabel}</span>
                    <span style="flex:1"></span>
                    <span id="run-elapsed">00:00</span>
                </div>
                ${loadState === "paused" ? `<div class="paused-overlay"><span>⏸ Paused</span></div>` : ""}
                <div class="progress-container ${loadState === "paused" ? "dimmed" : ""}">
                    <div class="current-obj" id="current-obj">Initializing…</div>
                    <div class="progress-track"><div class="progress-bar" id="progress-bar-obj" style="width:0%"></div></div>
                    <div class="progress-label" id="progress-label-obj">0 / 0</div>
                    <div class="progress-track" style="margin-top:4px"><div class="progress-bar progress-bar-overall" id="progress-bar-overall" style="width:0%"></div></div>
                    <div class="progress-label" id="progress-label-overall">Overall: 0 / ${config.objects.filter(o => o.active !== false).length}</div>
                </div>
                <div class="run-controls">
                    ${loadState === "paused"
                    ? `<button class="btn btn-primary" onclick="send('resume')">▶ Resume</button>`
                    : `<button class="btn" onclick="send('pause')">⏸ Pause</button>`}
                    <button class="btn" onclick="send('skipObject')">⏭ Skip Object</button>
                    <button class="btn danger-btn" onclick="send('cancel')">✕ Cancel</button>
                </div>
                <div class="log-area" id="log-area">${loadLog.map((l) => `<div class="log-line ${l.level}">${esc(l.text)}</div>`).join("")}</div>`;
            }
            return `
            <div class="run-idle-card">
                <div class="field-row" style="margin-bottom:12px">
                    <label style="width:100px">Target Org</label>
                    <select id="loadTargetOrg" class="select" ${dis} onchange="if(this.value==='**connect**')send('openConnectOrg');else send('setTargetOrg',{alias:this.value})">
                        ${orgOptions(targetOrg)}
                    </select>
                </div>
                <div class="toggle-row" style="margin-bottom:16px">
                    <label class="toggle-sw"><input type="checkbox" id="dryRunToggle" ${dryRun ? "checked" : ""} ${dis}><span class="slider"></span></label>
                    <span class="toggle-label">Dry Run — validate only, no records inserted</span>
                </div>
                <div style="display:flex;gap:10px;flex-wrap:wrap">
                    <button class="btn btn-primary" ${dis} onclick="startLoad()">⬆ Load to Target</button>
                    ${recentLogs.length > 0 ? `<button class="btn" onclick="send('viewLoadLog',{targetOrg:document.getElementById('loadTargetOrg')?.value||${esc(JSON.stringify(targetOrg))}})" style="margin-left:auto">📄 Last Load Log</button>` : ""}
                </div>
                ${isDone ? `<div class="done-banner">✅ Load complete. Check the Tracking tab for results.</div>` : ""}
            </div>
            <div class="log-area" id="log-area" style="margin-top:16px">${loadLog.map((l) => `<div class="log-line ${l.level}">${esc(l.text)}</div>`).join("")}</div>`;
        };
        // ── Tab 4: Tracking ──────────────────────────────────────────────────
        const renderTrackingTab = () => {
            const seedDir = path.resolve(this._workspaceRoot, config.seedDir);
            const trackMap = tracking ?? {};
            // Org selector: pipeline orgs + tracked orgs + availableOrgs (deduplicated)
            const allTrackOrgs = new Set([
                ...(targetOrg ? [targetOrg] : []),
                ...trackedOrgs,
                ...[...pipelineAliases],
                ...availableOrgs.map(o => o.alias),
            ]);
            const orgSelectorOpts = [...allTrackOrgs].map(o => `<option value="${esc(o)}"${o === trackingOrg ? " selected" : ""}>${esc(o)}</option>`).join("");
            // Show any object that has seed data OR tracking entries
            const allObjects = new Set(Object.keys(trackMap));
            for (const obj of (config.objects ?? []).filter(o => o.active !== false)) {
                if (countSeedRecords(seedDir, obj.sobject) > 0) {
                    allObjects.add(obj.sobject);
                }
            }
            const emptyMsg = allObjects.size === 0
                ? `<p style="color:var(--vscode-descriptionForeground);margin-top:16px">No data yet for <strong>${esc(trackingOrg || "(no org)")}</strong>. Pull data first, then run a load.</p>`
                : "";
            let rows = "";
            for (const obj of allObjects) {
                const t = trackMap[obj] ?? {};
                let created = 0, failed = 0, skipped = 0, pending = 0, blocked = 0;
                for (const entry of Object.values(t)) {
                    if (entry.status === "created") {
                        created++;
                    }
                    else if (entry.status === "failed") {
                        failed++;
                    }
                    else if (entry.status === "skipped") {
                        skipped++;
                    }
                    else if (entry.status === "blocked") {
                        blocked++;
                    }
                    else {
                        pending++;
                    }
                }
                const seedCount = countSeedRecords(seedDir, obj);
                const loadTotal = created + failed + skipped + pending + blocked;
                const progressPct = seedCount > 0 ? Math.round((created / seedCount) * 100) : 0;
                const progressBar = seedCount > 0
                    ? `<div style="width:80px;height:6px;background:var(--vscode-editorWidget-border);border-radius:3px;display:inline-block;vertical-align:middle;margin-left:4px"><div style="width:${progressPct}%;height:100%;background:#00c9b1;border-radius:3px"></div></div>`
                    : "";
                rows += `<tr>
                    <td><code>${esc(obj)}</code></td>
                    <td>${seedCount > 0 ? `<strong>${seedCount}</strong>` : "—"}</td>
                    <td>${loadTotal > 0 ? loadTotal : "—"}</td>
                    <td>${created}${progressBar}</td>
                    <td class="${failed > 0 ? "cell-red" : ""}">${failed > 0 ? `<strong>${failed}</strong>` : "0"}</td>
                    <td>${skipped}</td>
                    <td>${pending > 0 ? `<span style="color:var(--vscode-descriptionForeground)">${pending}</span>` : "0"}</td>
                    <td>${blocked}</td>
                    <td class="row-actions">
                        ${failed > 0 ? `<button class="btn btn-sm" ${dis} onclick="send('viewErrors',{sobject:${esc(JSON.stringify(obj))},targetOrg:${esc(JSON.stringify(trackingOrg))}})" title="Show error details for failed records">⚠ Errors</button>` : ""}
                        ${failed > 0 ? `<button class="btn btn-sm" ${dis} onclick="send('retryFailed',{sobject:${esc(JSON.stringify(obj))},targetOrg:${esc(JSON.stringify(trackingOrg))}})">Retry Failed</button>` : ""}
                        <button class="btn btn-sm btn-primary" title="Clear tracking history and reload this object" ${dis} onclick="send('clearAndReload',{sobject:${esc(JSON.stringify(obj))},targetOrg:${esc(JSON.stringify(trackingOrg))}})">↺ Rerun</button>
                        <button class="btn btn-sm danger-btn" title="Clear tracking only (no Salesforce delete)" ${dis} onclick="if(confirm('Clear tracking for ${esc(obj)}?'))send('clearObject',{sobject:${esc(JSON.stringify(obj))},targetOrg:${esc(JSON.stringify(trackingOrg))}})">Clear</button>
                    </td>
                </tr>`;
            }
            return `
            <div class="toolbar" style="margin-bottom:14px;align-items:center">
                <label style="font-size:12px;color:var(--vscode-descriptionForeground)">Viewing org:</label>
                <select class="select" ${dis} onchange="send('selectTrackingOrg',{org:this.value})">${orgSelectorOpts}</select>
                <button class="icon-btn" onclick="send('refreshTracking')" title="Refresh stats from tracking file">🔄 Refresh Stats</button>
                <button class="icon-btn" ${dis} onclick="send('refreshOrgs')" title="Refresh org list">⚙️ Orgs</button>
            </div>

            ${emptyMsg}

            ${allObjects.size > 0 ? `
            <div class="table-wrap">
                <table class="data-table">
                    <thead><tr><th>Object</th><th title="Records in seed files">Pulled</th><th title="Records attempted in Load">Attempted</th><th>Created</th><th>Failed</th><th>Skipped</th><th>Pending</th><th>Blocked</th><th>Actions</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <div class="toolbar" style="margin-top:14px">
                <button class="btn btn-primary" ${dis} onclick="send('retryFailed',{targetOrg:${esc(JSON.stringify(trackingOrg))}})">Retry All Failed</button>
                <button class="btn btn-accent" ${dis} onclick="send('clearAllAndReload',{targetOrg:${esc(JSON.stringify(trackingOrg))}})">↺ Clear All &amp; Reload</button>
                <button class="btn" ${dis} title="Re-check failed records against target org and fix tracking for any that actually landed" onclick="if(confirm('Reconcile tracking for ${esc(trackingOrg)}? This will SOQL-query the target org to verify which failed records actually exist there.'))send('reconcileTracking',{targetOrg:${esc(JSON.stringify(trackingOrg))}})">🔍 Reconcile</button>
                <button class="btn" ${dis} title="Query target org and verify record counts against tracking" onclick="send('validateMigration',{targetOrg:${esc(JSON.stringify(trackingOrg))}})">✓ Validate Migration</button>
                <button class="btn danger-btn" ${dis} onclick="send('rollback',{targetOrg:${esc(JSON.stringify(trackingOrg))},dryRun:false})">🗑 Full Rollback</button>
                <button class="btn" ${dis} onclick="send('exportCsv',{targetOrg:${esc(JSON.stringify(trackingOrg))}})">Export CSV</button>
                <button class="btn" onclick="send('viewLoadLog',{targetOrg:${esc(JSON.stringify(trackingOrg))}})">📄 Load Log</button>
            </div>` : ""}`;
        };
        // ── Tab 4: External IDs ──────────────────────────────────────────────
        const renderExtIdsTab = () => {
            const activeObjs = (config.objects ?? []).filter((o) => o.active !== false);
            if (activeObjs.length === 0) {
                return `<p style="color:var(--vscode-descriptionForeground)">No active objects configured.</p>`;
            }
            let rows = "";
            for (const obj of activeObjs) {
                const status = obj.externalIdField
                    ? `<span class="badge badge-green">✅ Verified</span>`
                    : `<span class="badge badge-amber">⚠️ Not set</span>`;
                rows += `<tr>
                    <td><code>${esc(obj.sobject)}</code></td>
                    <td>${esc(obj.externalIdField ?? "—")}</td>
                    <td>${status}</td>
                    <td class="row-actions">
                        <button class="btn btn-sm" ${dis} onclick="send('checkExtId',{sobject:${esc(JSON.stringify(obj.sobject))},targetOrg:${esc(JSON.stringify(targetOrg))}})">Re-check</button>
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
                <button class="btn btn-primary" ${dis} onclick="send('checkAllExtIds',{targetOrg:${esc(JSON.stringify(targetOrg))}})">Re-check All</button>
                <span style="color:var(--vscode-descriptionForeground);font-size:12px;margin-left:12px">If a field is missing, create it manually in Salesforce Setup.</span>
            </div>
            <div class="log-area" id="log-area" style="margin-top:16px">${loadLog.map((l) => `<div class="log-line ${l.level}">${esc(l.text)}</div>`).join("")}</div>`;
        };
        const tabContent = activeTab === "config" ? renderConfigTab()
            : activeTab === "pull" ? renderPullTab()
                : activeTab === "load" ? renderLoadTab()
                    : activeTab === "tracking" ? renderTrackingTab()
                        : renderExtIdsTab();
        const tabNav = tabs.map(({ id, label }) => `<button class="tab-btn ${activeTab === id ? "tab-active" : ""}" onclick="send('switchTab',{tab:'${id}'})">${label}</button>`).join("");
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
${(0, shared_1.cspMeta)(this._panel.webview)}
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Data Migration</title>
<style>
${(0, shared_1.sharedCss)()}

/* ── Layout ── */
body { padding: 0; overflow: hidden; display: flex; flex-direction: column; height: 100vh; }
.sticky-header { position: sticky; top: 0; z-index: 100; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
.panel-title-bar { display: flex; align-items: center; gap: 12px; padding: 10px 20px 0; }
.panel-title { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.role-badge { font-size: 10px; background: #00C9B1; color: #000; border-radius: 4px; padding: 2px 7px; font-weight: 600; text-transform: uppercase; }
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

/* ── Global busy/error banners — visible no matter which tab is active ── */
.global-busy-banner { display: flex; align-items: center; gap: 8px; padding: 6px 20px; font-size: 12px; font-weight: 600; background: #00C9B1; color: #000; }
.global-busy-banner[hidden] { display: none; }
.spinner { width: 12px; height: 12px; border: 2px solid rgba(0,0,0,0.3); border-top-color: #000; border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.global-error-banner { display: flex; align-items: center; gap: 8px; padding: 8px 20px; font-size: 12px; font-weight: 600; background: #F44336; color: #fff; }
.global-error-banner[hidden] { display: none; }
.global-error-banner #global-error-text { flex: 1; white-space: pre-wrap; word-break: break-word; }
.global-error-banner .icon-btn { color: #fff; }

/* ── Log area ── */
.log-area { background: var(--vscode-terminal-background, #1e1e1e); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; max-height: 320px; overflow-y: auto; color: var(--vscode-terminal-foreground, #ccc); }
.log-line { white-space: pre-wrap; word-break: break-all; line-height: 1.55; color: var(--vscode-terminal-foreground, #d4d4d4); }
.log-line.success { color: #4EC9B0; }
.log-line.info    { color: #9CDCFE; }
.log-line.warn    { color: #FFC107; }
.log-line.error   { color: #F44336; }

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
    <div id="global-busy-banner" class="global-busy-banner" ${busy ? "" : "hidden"}>
        <span class="spinner"></span>
        <span id="global-busy-label">${esc(busyLabel)}</span>
        <span style="flex:1"></span>
        <span id="global-busy-elapsed">00:00</span>
    </div>
    <div id="global-error-banner" class="global-error-banner" ${lastError ? "" : "hidden"}>
        <span id="global-error-text">❌ ${esc(lastError ?? "")}</span>
        <button class="icon-btn" onclick="dismissGlobalError()" title="Dismiss">✕</button>
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
function getPullSourceOrg() { return getVal('pullSourceOrg') || ''; }
function getLoadTargetOrg() { return getVal('loadTargetOrg') || ''; }
function startPull()        { send('pull',        { sourceOrg: getPullSourceOrg(), dryRun: getDryRun() }); }
function startLoad()        { send('load',        { targetOrg: getLoadTargetOrg(), dryRun: getDryRun() }); }
function startPullAndLoad() { send('pullAndLoad', { sourceOrg: getPullSourceOrg(), targetOrg: getLoadTargetOrg(), dryRun: getDryRun() }); }

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
// Kill any orphaned timer from a previous page render — _refresh() replaces the entire HTML,
// so the old IIFE's local _elapsedTimer handle is lost, creating a leaked setInterval each time.
// Storing on window ensures there is always at most one timer running.
if (window._elapsedTimer) { clearInterval(window._elapsedTimer); window._elapsedTimer = null; }
let _elapsedSecs = window._elapsedSecs || 0;

function startElapsedTimer(reset) {
    if (reset !== false) { window._elapsedSecs = 0; _elapsedSecs = 0; }
    else { _elapsedSecs = window._elapsedSecs || 0; }
    if (window._elapsedTimer) { clearInterval(window._elapsedTimer); }
    window._elapsedTimer = setInterval(function() {
        _elapsedSecs++;
        window._elapsedSecs = _elapsedSecs;
        const m = String(Math.floor(_elapsedSecs / 60)).padStart(2,'0');
        const s = String(_elapsedSecs % 60).padStart(2,'0');
        const text = m + ':' + s;
        const el = document.getElementById('run-elapsed');
        if (el) { el.textContent = text; }
        const globalEl = document.getElementById('global-busy-elapsed');
        if (globalEl) { globalEl.textContent = text; }
    }, 1000);
}

function stopElapsedTimer() {
    if (window._elapsedTimer) { clearInterval(window._elapsedTimer); window._elapsedTimer = null; }
    window._elapsedSecs = 0;
    _elapsedSecs = 0;
}

// Reconnect timer if panel re-rendered while a run is still in progress (don't reset elapsed)
if (DATA.busy) {
    startElapsedTimer(false);
}

function updateProgress(data) {
    const curObj = document.getElementById('current-obj');
    if (curObj && data.currentObject) { curObj.textContent = data.currentObject; }

    const barObj = document.getElementById('progress-bar-obj');
    const lblObj = document.getElementById('progress-label-obj');
    if (barObj && data.batchCount > 0) {
        const pct = Math.round((data.batchIndex / data.batchCount) * 100);
        barObj.style.width = pct + '%';
        if (lblObj) { lblObj.textContent = data.batchIndex + ' / ' + data.batchCount; }
    }

    const barAll = document.getElementById('progress-bar-overall');
    const lblAll = document.getElementById('progress-label-overall');
    if (barAll && data.objectCount > 0) {
        const pct = Math.round((data.objectIndex / data.objectCount) * 100);
        barAll.style.width = pct + '%';
        if (lblAll) { lblAll.textContent = 'Overall: ' + data.objectIndex + ' / ' + data.objectCount; }
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

// Shows the error immediately (before the follow-up refresh re-renders the whole panel from
// server state) so it's visible the instant it happens, on whichever tab the user is looking at.
function handleRunError(message) {
    stopElapsedTimer();
    const banner = document.getElementById('run-banner');
    if (banner) { banner.textContent = '❌ Error: ' + message; banner.style.background = '#F44336'; banner.style.color = '#fff'; }
    appendLog('ERROR: ' + message, 'error');

    const globalBanner = document.getElementById('global-error-banner');
    const globalText = document.getElementById('global-error-text');
    if (globalBanner && globalText) {
        globalText.textContent = '❌ ' + message;
        globalBanner.hidden = false;
    }
}

function dismissGlobalError() {
    const el = document.getElementById('global-error-banner');
    if (el) { el.hidden = true; }
    send('dismissError');
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
window.getPullSourceOrg  = getPullSourceOrg;
window.getLoadTargetOrg  = getLoadTargetOrg;
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
window.dismissGlobalError  = dismissGlobalError;

})();
</script>
</body>
</html>`;
    }
}
exports.DataMigrationPanel = DataMigrationPanel;
//# sourceMappingURL=DataMigrationPanel.js.map