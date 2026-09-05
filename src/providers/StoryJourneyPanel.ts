// StoryJourneyPanel.ts — Full chronological lifecycle view for a single feature story.
//
// Combines two data sources:
//  1. Audit log filtered by storyId — rich detail for every extension-triggered event.
//  2. Git branch inspection per env — detects promotion-branch merges that happened outside
//     the extension (direct GitHub/Bitbucket UI merges) where no audit entry was written.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { AuditEntry, AuditDetails, OPERATION_LABELS } from "../AuditLog";
import {
    getPromotableEnvironments, getPublishEnvironment, extractStoryId,
    promoBranchName, buildTicketUrl, isFeatureBranch,
} from "../config";

interface JourneyEvent {
    timestamp: string;            // ISO 8601 — used for sort
    source: "audit" | "git";
    operation: string;
    targetEnv?: string;
    outcome: "success" | "failure" | "conflict" | "info";
    summary: string;
    details?: AuditDetails & { sha?: string };
}

interface PipelineStatus {
    envName:  string;
    label:    string;
    reached:  boolean;
    sha?:     string;
}

export class StoryJourneyPanel {
    private static _current: StoryJourneyPanel | undefined;

    static createOrShow(gitHelper: GitHelper, storyId?: string): void {
        if (StoryJourneyPanel._current) {
            StoryJourneyPanel._current._panel.reveal(vscode.ViewColumn.One);
            if (storyId) { StoryJourneyPanel._current._storyId = storyId; }
            StoryJourneyPanel._current._refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsStoryJourney",
            "Story Journey",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        StoryJourneyPanel._current = new StoryJourneyPanel(panel, gitHelper, storyId ?? "");
    }

    static refreshIfOpen(): void {
        StoryJourneyPanel._current?._refresh();
    }

    private readonly _disposables: vscode.Disposable[] = [];
    private _storyId: string;

    private constructor(
        private readonly _panel:     vscode.WebviewPanel,
        private readonly _gitHelper: GitHelper,
        storyId: string,
    ) {
        this._storyId = storyId;
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === "refresh") { await this._refresh(); }
            if (msg.command === "selectStory" && msg.storyId) {
                this._storyId = msg.storyId;
                await this._refresh();
            }
        }, null, this._disposables);
        this._panel.webview.html = this._loadingHtml();
        this._initAndRefresh();
    }

    private _dispose(): void {
        StoryJourneyPanel._current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    private async _initAndRefresh(): Promise<void> {
        if (!this._storyId) {
            const branch = await this._gitHelper.currentBranch();
            if (branch && isFeatureBranch(branch)) {
                this._storyId = extractStoryId(branch);
            }
        }
        await this._refresh();
    }

    private async _refresh(): Promise<void> {
        try {
            const allBranches = await this._gitHelper.listRemoteFeatureBranches();
            const storyIds = allBranches.map(b => extractStoryId(b) || b).filter(Boolean);

            if (!this._storyId && storyIds.length > 0) {
                this._storyId = storyIds[0];
            }

            if (!this._storyId) {
                this._panel.webview.html = this._noStoriesHtml();
                return;
            }

            const [events, pipeline] = await Promise.all([
                this._buildEvents(this._storyId),
                this._buildPipeline(this._storyId),
            ]);

            this._panel.title = `Journey — ${this._storyId}`;
            this._panel.webview.html = this._renderHtml(this._storyId, events, pipeline, storyIds);
        } catch (err) {
            this._panel.webview.html = `<body style="padding:20px;color:#f48771;font-family:sans-serif">Error: ${String(err)}</body>`;
        }
    }

    // ── Data assembly ────────────────────────────────────────────────────────

    private async _buildEvents(storyId: string): Promise<JourneyEvent[]> {
        const events: JourneyEvent[] = [];

        // 1. Audit log entries for this story.
        const auditEntries = await this._gitHelper.getAuditEntries();
        for (const e of auditEntries) {
            if (e.storyId !== storyId) { continue; }
            events.push({
                timestamp: e.timestamp,
                source: "audit",
                operation: OPERATION_LABELS[e.operation] ?? e.operation,
                targetEnv: e.targetEnv,
                outcome: e.outcome === "conflict" ? "conflict" : e.outcome === "failure" ? "failure" : "success",
                summary: e.summary,
                details: e.details,
            });
        }

        // 2. Git branch inspection — detect merges that happened outside the extension.
        //    For each env, check if the story commit is on its branch AND there is no
        //    matching promote/deploy audit entry already covering that env.
        const envs = [getPublishEnvironment(), ...getPromotableEnvironments()];
        for (const env of envs) {
            const hasAuditCoverage = events.some(
                ev => ev.source === "audit" &&
                      ev.targetEnv === env.name &&
                      (ev.operation.toLowerCase().includes("promot") || ev.operation.toLowerCase().includes("deploy"))
            );
            if (hasAuditCoverage) { continue; }

            const sha = await this._gitHelper.storyCommitShaOnBranch(env.branch, storyId).catch(() => null);
            if (!sha) { continue; }

            // Approximate timestamp: last commit date on that env branch near the sha.
            const ts = await this._gitHelper.branchLastCommitTimestamp(env.branch) ?? new Date().toISOString();
            events.push({
                timestamp: ts,
                source: "git",
                operation: `Merged to ${env.label}`,
                targetEnv: env.name,
                outcome: "success",
                summary: `Story commit detected on ${env.label} branch (merged outside extension)`,
                details: { sha },
            });
        }

        // Sort newest first.
        events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return events;
    }

    private async _buildPipeline(storyId: string): Promise<PipelineStatus[]> {
        const envs = [getPublishEnvironment(), ...getPromotableEnvironments()];
        return Promise.all(envs.map(async env => {
            const sha = await this._gitHelper.storyCommitShaOnBranch(env.branch, storyId).catch(() => null);
            return { envName: env.name, label: env.label, reached: !!sha, sha: sha ?? undefined };
        }));
    }

    // ── HTML rendering ───────────────────────────────────────────────────────

    private _loadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Loading story journey…</body></html>`;
    }

    private _noStoriesHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">No active feature branches found on the remote.</body></html>`;
    }

    private _renderHtml(storyId: string, events: JourneyEvent[], pipeline: PipelineStatus[], allStoryIds: string[]): string {
        const ticketUrl = buildTicketUrl(storyId);

        const storyTitle = ticketUrl
            ? `<a href="${escapeHtml(ticketUrl)}" class="story-link">${escapeHtml(storyId)}</a>`
            : escapeHtml(storyId);

        // Story picker — datalist gives type-to-search on large lists
        const datalistOptions = allStoryIds.map(id =>
            `<option value="${escapeHtml(id)}">`
        ).join("");

        // Pipeline bar
        const pipelineBar = pipeline.map((s, i) => {
            const icon = s.reached ? "✅" : "⬜";
            const cls  = s.reached ? "pipe-step reached" : "pipe-step";
            const sep  = i < pipeline.length - 1 ? `<span class="pipe-arrow">→</span>` : "";
            return `<span class="${cls}" title="${s.reached ? "Story commit found on this branch" : "Not yet reached"}">${icon} ${escapeHtml(s.label)}</span>${sep}`;
        }).join("");

        // Group events by date for day separators
        const eventHtml = this._renderTimeline(events);

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  :root { --bg:#1e1e1e; --fg:#e0e0e0; --card:#252526; --border:#3c3c3c; --muted:#888; --accent:#4fc3f7; --ok:#7cd992; --warn:#ffab70; --err:#f48771; --conflict:#e89d3f; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#fff; --fg:#1a1a1a; --card:#f5f5f5; --border:#ddd; --muted:#666; --accent:#0078d4; --ok:#1b6b2f; --warn:#a05000; --err:#c62828; --conflict:#b45309; }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 20px 32px 60px; max-width: 860px; }

  .header { margin-bottom: 16px; }
  h1 { font-size: 20px; margin: 0 0 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .story-link { color: var(--accent); text-decoration: none; }
  .story-link:hover { text-decoration: underline; }

  .controls { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
  select, input[type="text"] { background: var(--card); color: var(--fg); border: 1px solid var(--border); padding: 5px 10px; border-radius: 5px; font-size: 12px; }
  input[type="text"] { min-width: 180px; }
  .btn { font-size: 12px; padding: 5px 12px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--fg); }
  .btn:hover { opacity: 0.8; }

  /* Pipeline bar */
  .pipeline { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; margin-bottom: 18px; font-size: 12px; }
  .pipe-step { display: flex; align-items: center; gap: 3px; padding: 2px 6px; border-radius: 4px; }
  .pipe-step.reached { background: color-mix(in srgb, var(--ok) 15%, var(--bg)); }
  .pipe-arrow { color: var(--muted); padding: 0 2px; }

  /* Timeline */
  .day-sep { font-size: 11px; color: var(--muted); font-weight: 600; letter-spacing: .05em; text-transform: uppercase; margin: 18px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
  .timeline { position: relative; }
  .timeline::before { content: ""; position: absolute; left: 22px; top: 0; bottom: 0; width: 2px; background: var(--border); }

  .event { display: flex; gap: 12px; margin-bottom: 10px; position: relative; }
  .event-icon { width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; flex-shrink: 0; margin-top: 2px; z-index: 1; border: 2px solid var(--bg); }
  .icon-success  { background: var(--ok); }
  .icon-failure  { background: var(--err); }
  .icon-conflict { background: var(--conflict); }
  .icon-info     { background: var(--accent); }

  .event-body { flex: 1; background: var(--card); border: 1px solid var(--border); border-radius: 7px; padding: 9px 13px; }
  .event-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 3px; }
  .op-label { font-weight: 600; font-size: 13px; }
  .env-badge { font-size: 10px; background: color-mix(in srgb, var(--accent) 15%, var(--card)); color: var(--accent); border-radius: 4px; padding: 1px 6px; }
  .git-badge { font-size: 10px; background: color-mix(in srgb, var(--muted) 15%, var(--card)); color: var(--muted); border-radius: 4px; padding: 1px 6px; }
  .ts { font-size: 11px; color: var(--muted); margin-left: auto; white-space: nowrap; }
  .outcome-badge { font-size: 10px; border-radius: 3px; padding: 1px 6px; }
  .badge-success  { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
  .badge-failure  { background: color-mix(in srgb, var(--err) 20%, transparent); color: var(--err); }
  .badge-conflict { background: color-mix(in srgb, var(--conflict) 20%, transparent); color: var(--conflict); }

  .event-summary { color: var(--muted); font-size: 12px; margin-bottom: 4px; }

  .details { margin-top: 6px; }
  .toggle-link { font-size: 11px; color: var(--accent); cursor: pointer; text-decoration: none; }
  .toggle-link:hover { text-decoration: underline; }
  .detail-block { display: none; margin-top: 6px; font-size: 11px; color: var(--muted); }
  .detail-block.open { display: block; }
  .file-list { list-style: none; margin: 4px 0; padding: 0; max-height: 200px; overflow-y: auto; }
  .file-list li { padding: 2px 0; word-break: break-all; }
  .file-list li.added    { color: var(--ok); }
  .file-list li.modified { color: var(--accent); }
  .file-list li.deleted  { color: var(--err); }
  .test-row { display: flex; gap: 8px; margin-bottom: 3px; }
  .test-ok  { color: var(--ok); }
  .test-fail{ color: var(--err); }
  .sha-tag  { font-family: monospace; font-size: 10px; background: var(--border); padding: 1px 5px; border-radius: 3px; }
  .error-box { background: color-mix(in srgb, var(--err) 10%, var(--card)); border: 1px solid var(--err); border-radius: 4px; padding: 6px 10px; color: var(--err); margin-top: 4px; word-break: break-word; }

  .empty { color: var(--muted); padding: 32px; text-align: center; font-size: 14px; }
</style>
</head>
<body>

<div class="header">
  <h1>📜 Story Journey &mdash; ${storyTitle}</h1>
</div>

<datalist id="storyList">${datalistOptions}</datalist>
<div class="controls">
  <input type="text" id="storySearch" list="storyList" value="${escapeHtml(storyId)}" placeholder="Search story…" onchange="selectStory(this.value)">
  <button class="btn" onclick="send('refresh')">↻ Refresh</button>
</div>

<div class="pipeline" title="Pipeline stages reached by this story">${pipelineBar}</div>

${events.length === 0
    ? `<div class="empty">No events recorded for ${escapeHtml(storyId)} yet.<br>Start by creating a feature branch and publishing your first commit.</div>`
    : `<div class="timeline">${eventHtml}</div>`
}

<script>
  const vscode = acquireVsCodeApi();
  // JSON.stringify's own escaping is already valid JS as a direct array literal (JSON
  // syntax is a subset of JS expression syntax) — embedded with no surrounding quotes and
  // no JSON.parse(), so a story ID containing a literal ' can't prematurely close an outer
  // string literal the way a JSON.parse('...') wrapper's single quotes would. Unicode-
  // escaping < > & still guards against a "</script>" (or an entity-sensitive character)
  // inside a story ID ending this script block early.
  const VALID_IDS = new Set(${
      JSON.stringify(allStoryIds).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
  });
  function send(cmd, extra) { vscode.postMessage({ command: cmd, ...extra }); }
  // selectStory fires on commit (blur or Enter via datalist selection) — not on every keystroke,
  // which would navigate away mid-typing when a partial input matches a shorter story ID.
  function selectStory(id) { if (id && VALID_IDS.has(id)) { send('selectStory', { storyId: id }); } }
  function toggleDetail(id) {
    var el = document.getElementById(id);
    if (el) { el.classList.toggle('open'); }
  }
</script>
</body>
</html>`;
    }

    private _renderTimeline(events: JourneyEvent[]): string {
        if (events.length === 0) { return ""; }

        const parts: string[] = [];
        let lastDate = "";

        for (let i = 0; i < events.length; i++) {
            const ev = events[i];
            const date = ev.timestamp.slice(0, 10);
            if (date !== lastDate) {
                parts.push(`<div class="day-sep">${escapeHtml(formatDate(date))}</div>`);
                lastDate = date;
            }
            parts.push(this._renderEvent(ev, i));
        }

        return parts.join("");
    }

    private _renderEvent(ev: JourneyEvent, idx: number): string {
        const iconClass = `icon-${ev.outcome}`;
        const iconChar  = ev.outcome === "success" ? "✓" : ev.outcome === "failure" ? "✗" : ev.outcome === "conflict" ? "!" : "i";

        const envBadge  = ev.targetEnv ? `<span class="env-badge">${escapeHtml(ev.targetEnv.toUpperCase())}</span>` : "";
        const srcBadge  = ev.source === "git" ? `<span class="git-badge">git-detected</span>` : "";
        const outBadge  = ev.outcome !== "success"
            ? `<span class="outcome-badge badge-${ev.outcome}">${ev.outcome}</span>`
            : "";

        const timeStr = ev.timestamp.length >= 16
            ? ev.timestamp.slice(11, 16)   // HH:MM
            : ev.timestamp;

        const hasDetail = !!ev.details;
        const detailId  = `detail-${idx}`;

        let detailHtml = "";
        if (hasDetail) {
            const d = ev.details!;
            const sections: string[] = [];

            if (d.error) {
                sections.push(`<div class="error-box">⚠ ${escapeHtml(d.error)}</div>`);
            }
            if (d.changedFiles && d.changedFiles.length > 0) {
                const rows = d.changedFiles.map(f =>
                    `<li class="${f.change}">${escapeHtml(f.change === "added" ? "+" : f.change === "deleted" ? "−" : "~")} ${escapeHtml(f.path)}</li>`
                ).join("");
                sections.push(`<div><strong>${d.changedFiles.length} file(s):</strong><ul class="file-list">${rows}</ul></div>`);
            }
            if (d.testResults) {
                const tr = d.testResults;
                const perClass = tr.perClass.map(c =>
                    `<div class="test-row"><span class="${c.pass ? "test-ok" : "test-fail"}">${c.pass ? "✓" : "✗"}</span><span>${escapeHtml(c.name)}</span><span>${c.percent}%</span></div>`
                ).join("");
                sections.push(`<div><strong>Coverage:</strong> ${tr.passed ? "passed" : "failed"} (threshold ${tr.threshold}%, ${tr.testsFailed} test(s) failed)<br>${perClass}</div>`);
            }
            if (d.tests && d.tests.length > 0) {
                sections.push(`<div><strong>Tests run:</strong> ${escapeHtml(d.tests.join(", "))}</div>`);
            }
            if (d.conflicts && d.conflicts.length > 0) {
                sections.push(`<div><strong>Conflicts:</strong><ul class="file-list">${d.conflicts.map(f => `<li>${escapeHtml(f)}</li>`).join("")}</ul></div>`);
            }
            if (d.componentFailures && d.componentFailures.length > 0) {
                const rows = d.componentFailures.slice(0, 10).map(f =>
                    `<li class="deleted">${escapeHtml(f.type)} ${escapeHtml(f.name)}: ${escapeHtml(f.problem)}</li>`
                ).join("");
                sections.push(`<div><strong>${d.componentFailures.length} component failure(s):</strong><ul class="file-list">${rows}</ul></div>`);
            }
            if (d.prUrl) {
                sections.push(`<div><a href="${escapeHtml(d.prUrl)}" class="toggle-link">🔗 Pull Request</a></div>`);
            }
            if (d.deployId) {
                sections.push(`<div>Deploy ID: <span class="sha-tag">${escapeHtml(d.deployId)}</span></div>`);
            }
            if (d.sha) {
                sections.push(`<div>Commit: <span class="sha-tag">${escapeHtml(d.sha.slice(0, 8))}</span></div>`);
            }
            if (d.testLevel) {
                sections.push(`<div>Test level: <span class="sha-tag">${escapeHtml(d.testLevel)}</span></div>`);
            }
            if (d.tag) {
                sections.push(`<div>Git tag: <span class="sha-tag">${escapeHtml(d.tag)}</span></div>`);
            }
            if (d.note) {
                sections.push(`<div>${escapeHtml(d.note)}</div>`);
            }

            if (sections.length > 0) {
                detailHtml = `<a class="toggle-link" onclick="toggleDetail('${detailId}')">▸ details</a>
<div class="detail-block" id="${detailId}">${sections.join("<br>")}</div>`;
            }
        }

        return `<div class="event">
  <div class="event-icon ${iconClass}">${iconChar}</div>
  <div class="event-body">
    <div class="event-head">
      <span class="op-label">${escapeHtml(ev.operation)}</span>
      ${envBadge}${srcBadge}${outBadge}
      <span class="ts">${escapeHtml(timeStr)}</span>
    </div>
    <div class="event-summary">${escapeHtml(ev.summary)}</div>
    ${detailHtml}
  </div>
</div>`;
    }
}

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
}

function formatDate(iso: string): string {
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" });
}
