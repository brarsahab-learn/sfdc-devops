// AuditTrailPanel.ts — Audit trail with filter bar, scoped export, and management controls.

import * as vscode from "vscode";
import * as fs     from "fs";
import * as path   from "path";
import { GitHelper } from "../GitHelper";
import { AuditEntry, renderAuditHtml, OPERATION_LABELS } from "../AuditLog";

const SIZE_WARN_BYTES  = 5 * 1024 * 1024;   // 5 MB — show size guard warning
const SIZE_BLOCK_BYTES = 20 * 1024 * 1024;  // 20 MB — refuse to render, show action prompts only

export class AuditTrailPanel {
    private static current: AuditTrailPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(gitHelper: GitHelper) {
        if (AuditTrailPanel.current) {
            AuditTrailPanel.current._panel.reveal(vscode.ViewColumn.One);
            AuditTrailPanel.current._refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsAuditTrail",
            "SF DevOps Audit Trail",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        AuditTrailPanel.current = new AuditTrailPanel(panel, gitHelper);
    }

    // Keep the old refresh() call working from extension.ts (it still calls createOrShow).
    public static refresh(): void {
        AuditTrailPanel.current?._refresh();
    }

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly _gitHelper: GitHelper
    ) {
        this._panel = panel;
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === "refresh") { await this._refresh(); return; }
            if (msg.command === "export")  { await this._handleExport(msg); return; }
            if (msg.command === "trim")    { await this._handleTrim(msg.days); return; }
            if (msg.command === "clear")   { await this._handleClear(); return; }
        }, null, this._disposables);
        this._refresh();
    }

    private _dispose(): void {
        AuditTrailPanel.current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    // Preserve the old public API used by old callers (e.g. storyProvider).
    public async refresh() { await this._refresh(); }

    private async _refresh(): Promise<void> {
        try {
            const sizeBytes = await this._gitHelper.getAuditLogSizeBytes();

            if (sizeBytes >= SIZE_BLOCK_BYTES) {
                this._panel.webview.html = this._renderBlockedHtml(sizeBytes);
                return;
            }

            const entries = await this._gitHelper.getAuditEntries();
            this._panel.webview.html = this._renderPanelHtml(entries, sizeBytes);
        } catch (err) {
            this._panel.webview.html = `<body style="padding:16px;color:#f48771;font-family:sans-serif">Error loading audit trail: ${String(err)}</body>`;
        }
    }

    private async _handleExport(msg: { format: "json" | "html"; filterOp?: string; filterStory?: string }): Promise<void> {
        try {
            let entries = await this._gitHelper.getAuditEntries();
            if (msg.filterOp)    { entries = entries.filter(e => e.operation === msg.filterOp); }
            if (msg.filterStory) { entries = entries.filter(e => (e.storyId ?? "").toLowerCase().includes(msg.filterStory!.toLowerCase())); }

            const saveUri = await vscode.window.showSaveDialog({
                title: "Export Audit Log",
                defaultUri: vscode.Uri.file(path.join(this._gitHelper.getWorkspaceRoot(), `sf-devops-audit.${msg.format}`)),
                filters: msg.format === "json" ? { "JSON": ["json"] } : { "HTML": ["html"] },
            });
            if (!saveUri) { return; }

            const content = msg.format === "json"
                ? JSON.stringify(entries, null, 2)
                : renderAuditHtml(entries);
            await fs.promises.writeFile(saveUri.fsPath, content, "utf8");
            vscode.window.showInformationMessage(`Audit log exported to ${path.basename(saveUri.fsPath)} (${entries.length} entries).`);
        } catch (err) {
            vscode.window.showErrorMessage(`Export failed: ${err}`);
        }
    }

    private async _handleTrim(days: number): Promise<void> {
        const ms = days * 24 * 60 * 60 * 1000;
        const confirm = await vscode.window.showWarningMessage(
            `Delete audit entries older than ${days} day${days === 1 ? "" : "s"}?`,
            { modal: true }, "Yes, delete"
        );
        if (confirm !== "Yes, delete") { return; }
        const removed = await this._gitHelper.trimAuditLog(ms);
        vscode.window.showInformationMessage(`Removed ${removed} audit entr${removed === 1 ? "y" : "ies"}.`);
        await this._refresh();
    }

    private async _handleClear(): Promise<void> {
        const confirm = await vscode.window.showWarningMessage(
            "Clear the ENTIRE audit log? This cannot be undone.",
            { modal: true }, "Yes, clear all"
        );
        if (confirm !== "Yes, clear all") { return; }
        await this._gitHelper.trimAuditLog(0);  // 0 = clear all
        vscode.window.showInformationMessage("Audit log cleared.");
        await this._refresh();
    }

    private _renderBlockedHtml(sizeBytes: number): string {
        const mb = (sizeBytes / (1024 * 1024)).toFixed(1);
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#e0e0e0;background:#1e1e1e">
<h2>⚠ Audit Log Too Large to Render (${mb} MB)</h2>
<p>The audit log is too large to render safely. Use the controls below to reduce it.</p>
<p>
  <button onclick="send('trim', 7)">Delete entries older than 7 days</button>
  <button onclick="send('trim', 30)">Delete entries older than 30 days</button>
  <button onclick="send('clear')" style="color:#ff6b6b">Clear all entries</button>
</p>
<script>
  const vscode = acquireVsCodeApi();
  function send(cmd, days) { vscode.postMessage({ command: cmd, days: days }); }
</script>
</body></html>`;
    }

    private _renderPanelHtml(entries: AuditEntry[], sizeBytes: number): string {
        const operations = [...new Set(entries.map(e => e.operation))].sort();
        const stories    = [...new Set(entries.map(e => e.storyId).filter(Boolean))].sort() as string[];
        const sizeKb     = Math.round(sizeBytes / 1024);
        const sizeWarn   = sizeBytes >= SIZE_WARN_BYTES
            ? `<div class="size-warn">⚠ Audit log is ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB — consider trimming older entries.</div>`
            : "";

        const opOptions = operations.map(op =>
            `<option value="${escapeHtml(op)}">${escapeHtml((OPERATION_LABELS as Record<string, string>)[op] ?? op)}</option>`
        ).join("");

        const storyOptions = stories.map(s =>
            `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`
        ).join("");

        // Build inline entry rows rather than using renderAuditHtml (which produces a
        // standalone HTML file without filter controls).
        const rows = entries.slice().reverse().map(e => {
            const ts  = new Date(e.timestamp).toLocaleString();
            const op  = (OPERATION_LABELS as Record<string, string>)[e.operation] ?? e.operation;
            const dot = e.outcome === "success" ? "🟢" : e.outcome === "failure" ? "🔴" : "🟡";
            return `<tr data-op="${escapeHtml(e.operation)}" data-story="${escapeHtml(e.storyId ?? "")}">
  <td class="ts">${escapeHtml(ts)}</td>
  <td>${dot} ${escapeHtml(op)}</td>
  <td>${e.storyId ? escapeHtml(e.storyId) : "<span class='muted'>—</span>"}</td>
  <td>${e.targetEnv ? escapeHtml(e.targetEnv) : "<span class='muted'>—</span>"}</td>
  <td class="summary">${escapeHtml(e.summary)}</td>
</tr>`;
        }).join("");

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { --bg:#1e1e1e; --fg:#e0e0e0; --card:#252526; --border:#3c3c3c; --muted:#888; --accent:#4fc3f7; --warn:#ffab70; --err:#ff6b6b; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fff; --fg:#1a1a1a; --card:#f5f5f5; --border:#ddd; --muted:#666; --accent:#0078d4; --warn:#a05000; --err:#c62828; }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 16px 20px 60px; }
  h1 { font-size: 17px; margin: 0 0 4px; }
  .meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; }
  .size-warn { background: color-mix(in srgb, var(--warn) 15%, var(--card)); border: 1px solid var(--warn); color: var(--warn); border-radius: 6px; padding: 7px 12px; font-size: 12px; margin-bottom: 10px; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  select, input[type=text] { font-size: 12px; padding: 4px 7px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg); color: var(--fg); }
  .btn { font-size: 12px; padding: 4px 11px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--fg); }
  .btn:hover { background: var(--card); }
  .btn.danger { color: var(--err); border-color: var(--err); }
  .sep { color: var(--border); }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 5px 8px; border-bottom: 2px solid var(--border); color: var(--muted); font-weight: 600; font-size: 11px; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  tr.hidden { display: none; }
  .ts { white-space: nowrap; color: var(--muted); font-size: 11px; }
  .summary { max-width: 380px; }
  .muted { color: var(--muted); }
  .trim-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
</style>
</head>
<body>
<h1>Audit Trail</h1>
<div class="meta">${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ${sizeKb > 0 ? sizeKb + " KB" : "empty"}</div>
${sizeWarn}

<div class="toolbar">
  <select id="filterOp" onchange="applyFilter()">
    <option value="">All operations</option>
    ${opOptions}
  </select>
  <select id="filterStory" onchange="applyFilter()">
    <option value="">All stories</option>
    ${storyOptions}
  </select>
  <input type="text" id="filterText" placeholder="Search…" oninput="applyFilter()" style="width:160px">
  <span class="sep">|</span>
  <button class="btn" onclick="exportAudit('json')">⬇ Export JSON</button>
  <button class="btn" onclick="exportAudit('html')">⬇ Export HTML</button>
  <span class="sep">|</span>
  <button class="btn" onclick="vscode.postMessage({command:'refresh'})">↻ Refresh</button>
</div>

<div class="trim-row">
  <span style="font-size:11px;color:var(--muted)">Trim:</span>
  <button class="btn" onclick="trim(7)">Older than 7 days</button>
  <button class="btn" onclick="trim(30)">Older than 30 days</button>
  <button class="btn" onclick="trim(90)">Older than 90 days</button>
  <button class="btn danger" onclick="clearAll()">Clear all</button>
</div>

<br>
<table>
  <thead><tr><th>Time</th><th>Operation</th><th>Story</th><th>Env</th><th>Summary</th></tr></thead>
  <tbody id="rows">${rows}</tbody>
</table>

<script>
  const vscode = acquireVsCodeApi();

  function applyFilter() {
    const op    = document.getElementById('filterOp').value;
    const story = document.getElementById('filterStory').value;
    const text  = document.getElementById('filterText').value.toLowerCase();
    document.querySelectorAll('#rows tr').forEach(function(tr) {
      var show = true;
      if (op    && tr.dataset.op    !== op)                             { show = false; }
      if (story && tr.dataset.story !== story)                          { show = false; }
      if (text  && !tr.textContent.toLowerCase().includes(text))        { show = false; }
      tr.className = show ? '' : 'hidden';
    });
  }

  function exportAudit(format) {
    var op    = document.getElementById('filterOp').value;
    var story = document.getElementById('filterStory').value;
    vscode.postMessage({ command: 'export', format: format, filterOp: op || undefined, filterStory: story || undefined });
  }

  function trim(days) { vscode.postMessage({ command: 'trim', days: days }); }
  function clearAll() { vscode.postMessage({ command: 'clear' }); }
</script>
</body>
</html>`;
    }
}

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
}
