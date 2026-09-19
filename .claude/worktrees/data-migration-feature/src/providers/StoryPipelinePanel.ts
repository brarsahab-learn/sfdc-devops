// StoryPipelinePanel.ts — Multi-story pipeline view.
// Shows every remote feature branch as a card positioned in the pipeline stage it has
// reached (Dev → QA → UAT → Prod). Two views: Swimlane (one row per environment) and
// Kanban (one column per environment). The user can toggle between them.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { getPromotableEnvironments, getPublishEnvironment, buildTicketUrl, getStaleStoryThresholdDays, extractStoryId, getTicketKeyPattern } from "../config";
import { storyIdFromMessage } from "../DeploymentPlanner";
import { sharedCss, cspMeta, loadingHtml } from "../ui/shared";

interface StoryCard {
    storyId:      string;
    branch:       string;
    lastActivity: string | null;  // ISO 8601
    stageIndex:   number;         // -1 = feature-only, 0 = dev, 1+ = QA/UAT/Prod index
    stageName:    string;
    isStale:      boolean;
    isComplete:   boolean;        // commit found on the prod/final branch (auto-detected)
    isInactive:   boolean;        // explicitly marked inactive by the user
    ticketUrl:    string | undefined;
}

export class StoryPipelinePanel {
    private static _current: StoryPipelinePanel | undefined;

    static createOrShow(gitHelper: GitHelper): void {
        if (StoryPipelinePanel._current) {
            StoryPipelinePanel._current._panel.reveal(vscode.ViewColumn.One);
            StoryPipelinePanel._current._refresh();
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            "sfDevopsPipeline",
            "Salesforce-DevOps — Story Pipeline",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        StoryPipelinePanel._current = new StoryPipelinePanel(panel, gitHelper);
    }

    static refreshIfOpen(): void {
        StoryPipelinePanel._current?._refresh();
    }

    private readonly _disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly _panel: vscode.WebviewPanel,
        private readonly _gitHelper: GitHelper,
    ) {
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg) => {
            if (msg.command === "refresh") { await this._refresh(); }
            if (msg.command === "openBranch" && msg.branch) {
                await vscode.commands.executeCommand("sfDevops.resumeStory");
            }
            if (msg.command === "openJourney" && msg.storyId) {
                await vscode.commands.executeCommand("sfDevops.openStoryJourney", msg.storyId);
            }
            if (msg.command === "markInactive" && msg.storyId) {
                try {
                    await this._gitHelper.markStoryInactive(msg.storyId);
                    await this._refresh();
                } catch (err) {
                    vscode.window.showErrorMessage(`Could not mark story inactive: ${err}`);
                }
            }
            if (msg.command === "markActive" && msg.storyId) {
                try {
                    await this._gitHelper.markStoryActive(msg.storyId);
                    await this._refresh();
                } catch (err) {
                    vscode.window.showErrorMessage(`Could not restore story: ${err}`);
                }
            }
            if (msg.command === "openDashboard" && msg.env) {
                await vscode.commands.executeCommand("sfDevops.openDeploymentDashboard", msg.env);
            }
        }, null, this._disposables);

        this._panel.webview.html = this._loadingHtml();
        this._refresh();
    }

    private _dispose(): void {
        StoryPipelinePanel._current = undefined;
        this._panel.dispose();
        while (this._disposables.length) { this._disposables.pop()?.dispose(); }
    }

    private _refreshing = false;
    private async _refresh(): Promise<void> {
        if (this._refreshing) { return; }
        this._refreshing = true;
        try {
            const cards = await this._buildCards();
            this._panel.webview.html = this._renderHtml(cards);
        } finally {
            this._refreshing = false;
        }
    }

    private async _buildCards(): Promise<StoryCard[]> {
        const envs      = getPromotableEnvironments();
        const devEnv    = getPublishEnvironment();
        const allEnvs   = [devEnv, ...envs];
        const prodEnv   = envs.find(e => e.isProd) ?? envs[envs.length - 1]; // final stage = "complete"
        const pattern   = getTicketKeyPattern();
        const staleDay  = getStaleStoryThresholdDays();
        const now       = Date.now();

        // Load inactive story registry (user-explicitly-marked).
        const inactiveSet = await this._gitHelper.getInactiveStories();

        // Build map: envName → set of story IDs present in that env's branch log.
        const deployedInEnv = new Map<string, Set<string>>();
        for (const env of allEnvs) {
            const ids = new Set<string>();
            const log = await this._gitHelper.recentCommitsOnBranch(env.branch, 300);
            for (const c of log) {
                const id = storyIdFromMessage(c.message, pattern);
                if (id) { ids.add(id); }
            }
            deployedInEnv.set(env.name, ids);
        }

        const remoteBranches = await this._gitHelper.listRemoteFeatureBranches();
        const cards: StoryCard[] = [];

        for (const branch of remoteBranches) {
            const storyId   = extractStoryId(branch) || branch;
            const ticketUrl = buildTicketUrl(storyId);
            const lastActivity = await this._gitHelper.branchLastCommitTimestamp(branch);

            // Find the highest env this story has reached (last in the pipeline wins).
            let stageIndex = -1;
            let stageName  = "Feature";
            for (let i = allEnvs.length - 1; i >= 0; i--) {
                if (deployedInEnv.get(allEnvs[i].name)?.has(storyId)) {
                    stageIndex = i;
                    stageName  = allEnvs[i].label;
                    break;
                }
            }

            const ageMs     = lastActivity ? now - new Date(lastActivity).getTime() : 0;
            const isStale   = staleDay > 0 && ageMs > staleDay * 24 * 60 * 60 * 1000;
            // A story is "complete" if its commit appears on the prod/final env branch.
            const isComplete = prodEnv ? (deployedInEnv.get(prodEnv.name)?.has(storyId) ?? false) : false;
            const isInactive = inactiveSet.has(storyId);

            cards.push({ storyId, branch, lastActivity, stageIndex, stageName, isStale, isComplete, isInactive, ticketUrl });
        }

        // Sort: highest stage first, then most recently active.
        cards.sort((a, b) => {
            if (b.stageIndex !== a.stageIndex) { return b.stageIndex - a.stageIndex; }
            return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
        });

        return cards;
    }

    private _loadingHtml(): string {
        return loadingHtml("Loading pipeline…");
    }

    private _renderHtml(cards: StoryCard[]): string {
        const envs   = getPromotableEnvironments();
        const devEnv = getPublishEnvironment();
        const allEnvs = [devEnv, ...envs];

        // Group cards by stage index.
        const byStage = new Map<number, StoryCard[]>();
        byStage.set(-1, []);
        for (let i = 0; i < allEnvs.length; i++) { byStage.set(i, []); }
        for (const c of cards) {
            const bucket = byStage.get(c.stageIndex) ?? byStage.get(-1)!;
            bucket.push(c);
        }

        const stageLabels = ["Feature (not yet deployed)", ...allEnvs.map(e => e.label)];
        const stageKeys   = [-1, ...allEnvs.map((_, i) => i)];

        const completedCount = cards.filter(c => c.isComplete && !c.isInactive).length;
        const inactiveCount  = cards.filter(c => c.isInactive).length;
        const activeCount    = cards.filter(c => !c.isComplete && !c.isInactive).length;

        const cardHtml = (card: StoryCard) => {
            const age   = card.lastActivity
                ? `<span class="age">${this._relativeAge(card.lastActivity)}</span>`
                : "";
            const staleBadge    = card.isStale    ? `<span class="stale-badge">stale</span>` : "";
            const completeBadge = card.isComplete ? `<span class="complete-badge">🏁 done</span>` : "";
            const inactiveBadge = card.isInactive ? `<span class="inactive-badge">💤 inactive</span>` : "";
            const link = card.ticketUrl
                ? `<a href="${escapeHtml(card.ticketUrl)}" class="ticket-link">${escapeHtml(card.storyId)}</a>`
                : `<span class="story-id">${escapeHtml(card.storyId)}</span>`;
            const journeyBtn  = `<a class="card-action" href="#" onclick="openJourney('${escapeForOnclickArg(card.storyId)}')" title="View full journey">📜</a>`;
            const inactiveBtn = card.isInactive
                ? `<a class="card-action" href="#" onclick="markActive('${escapeForOnclickArg(card.storyId)}')" title="Restore to active tracking">↩</a>`
                : `<a class="card-action" href="#" onclick="markInactive('${escapeForOnclickArg(card.storyId)}')" title="Mark as inactive (hide from default view)">💤</a>`;
            const cls = [
                "card",
                card.isStale    ? "stale"    : "",
                card.isComplete ? "complete" : "",
                card.isInactive ? "inactive" : "",
            ].filter(Boolean).join(" ");
            return `<div class="${cls}" data-story="${escapeHtml(card.storyId)}" data-complete="${card.isComplete}" data-inactive="${card.isInactive}">
  <div class="card-head">${link}${staleBadge}${completeBadge}${inactiveBadge}</div>
  <div class="card-meta">${escapeHtml(card.branch)}${age}</div>
  <div class="card-actions">${journeyBtn}${inactiveBtn}</div>
</div>`;
        };

        const swimlaneRows = stageKeys.map((key, idx) => {
            const stagecards = byStage.get(key) ?? [];
            if (stagecards.length === 0) { return ""; }
            return `<div class="swimlane">
  <div class="lane-label">${escapeHtml(stageLabels[idx])} <span class="count">${stagecards.length}</span></div>
  <div class="lane-cards">${stagecards.map(cardHtml).join("")}</div>
</div>`;
        }).join("");

        const kanbanCols = stageKeys.map((key, idx) => {
            const stagecards = byStage.get(key) ?? [];
            return `<div class="kol">
  <div class="kol-head">${escapeHtml(stageLabels[idx])} <span class="count">${stagecards.length}</span></div>
  <div class="kol-body">${stagecards.map(cardHtml).join("")}</div>
</div>`;
        }).join("");

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${cspMeta(this._panel.webview)}
<style>
  ${sharedCss()}
  * { box-sizing: border-box; }
  body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 16px 24px 60px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .view-btn { font-size: 12px; padding: 4px 12px; border-radius: 5px; border: 1px solid var(--vscode-panel-border); cursor: pointer; background: transparent; color: var(--vscode-foreground); }
  .view-btn.active { background: var(--vscode-button-background); color: #fff; border-color: var(--vscode-button-background); }
  .refresh-btn { font-size: 12px; padding: 4px 10px; border-radius: 5px; border: 1px solid var(--vscode-panel-border); cursor: pointer; background: transparent; color: var(--vscode-descriptionForeground); }
  .muted { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .count { font-size: 11px; background: var(--vscode-panel-border); border-radius: 8px; padding: 1px 6px; }
  .filter-row { display: flex; gap: 8px; margin-bottom: 12px; align-items: center; flex-wrap: wrap; }
  .filter-row input, .filter-row select { background: var(--vscode-editor-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 5px 10px; font-size: 12px; }
  .filter-row input { flex: 1; min-width: 120px; }
  .hidden { display: none !important; }

  /* Swimlane */
  .swimlane { margin-bottom: 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
  .lane-label { padding: 7px 12px; font-weight: 600; font-size: 12px; background: color-mix(in srgb, var(--vscode-button-background) 10%, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border); }
  .lane-cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px; min-height: 52px; }

  /* Kanban */
  .kanban { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; }
  .kol { flex: 0 0 200px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; overflow: hidden; }
  .kol-head { padding: 7px 10px; font-weight: 600; font-size: 12px; background: color-mix(in srgb, var(--vscode-button-background) 10%, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-panel-border); }
  .kol-body { padding: 8px; min-height: 80px; display: flex; flex-direction: column; gap: 6px; }

  /* Card */
  .card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 7px 10px; font-size: 12px; min-width: 140px; }
  .card.stale { border-color: var(--vscode-notificationsWarningIcon-foreground,#e6a817); }
  .card-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .card-meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 3px; word-break: break-all; }
  .story-id { font-weight: 600; color: var(--vscode-button-background); }
  .ticket-link { font-weight: 600; color: var(--vscode-button-background); text-decoration: none; }
  .ticket-link:hover { text-decoration: underline; }
  .stale-badge    { font-size: 10px; background: var(--vscode-notificationsWarningIcon-foreground,#e6a817); color: #1a1a1a; border-radius: 3px; padding: 0 4px; }
  .complete-badge { font-size: 10px; background: var(--vscode-charts-green,#4caf50);   color: #1a1a1a; border-radius: 3px; padding: 0 4px; }
  .inactive-badge { font-size: 10px; background: var(--vscode-panel-border); color: var(--vscode-descriptionForeground); border-radius: 3px; padding: 0 4px; }
  .card.complete  { border-color: var(--vscode-charts-green,#4caf50); opacity: 0.85; }
  .card.inactive  { border-color: var(--vscode-panel-border); opacity: 0.6; border-style: dashed; }
  .age { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 4px; }
  .card-actions { display: flex; gap: 6px; margin-top: 4px; }
  .card-action  { font-size: 12px; text-decoration: none; opacity: 0.55; }
  .card-action:hover { opacity: 1; }
  .toggle-btn { font-size: 11px; padding: 3px 8px; border-radius: 4px; border: 1px solid var(--vscode-panel-border); cursor: pointer; background: transparent; color: var(--vscode-descriptionForeground); }
  .toggle-btn.on { background: color-mix(in srgb, var(--vscode-button-background) 15%, transparent); color: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  #swimlaneView, #kanbanView { display: none; }
  #swimlaneView.active, #kanbanView.active { display: block; }
  #kanbanView.active { display: flex; }
</style>
</head>
<body>
<h1>Story Pipeline</h1>
<div class="toolbar">
  <button class="view-btn active" id="btnSwimlane" onclick="setView('swimlane')">Swimlane</button>
  <button class="view-btn" id="btnKanban" onclick="setView('kanban')">Kanban</button>
  <button class="refresh-btn" onclick="refresh()">↻ Refresh</button>
  <button class="toggle-btn" id="btnComplete" onclick="toggleShow('complete')" title="Stories that have reached the final (prod) environment">${completedCount > 0 ? `🏁 Completed (${completedCount})` : "🏁 Completed"}</button>
  <button class="toggle-btn" id="btnInactive" onclick="toggleShow('inactive')" title="Stories explicitly marked inactive">${inactiveCount > 0 ? `💤 Inactive (${inactiveCount})` : "💤 Inactive"}</button>
  <span class="muted" id="storyCount">${activeCount} active</span>
</div>

<div class="filter-row">
  <input id="searchBox" type="text" placeholder="🔍 Search by story ID or branch…" oninput="applyFilter()">
  <select id="dateFilter" onchange="applyFilter()">
    <option value="">Any age</option>
    <option value="1">Active today</option>
    <option value="7">Last 7 days</option>
    <option value="30">Last 30 days</option>
    <option value="90">Last 90 days</option>
  </select>
  <select id="staleFilter" onchange="applyFilter()">
    <option value="">All stories</option>
    <option value="stale">Stale only</option>
    <option value="fresh">Active only</option>
  </select>
</div>

<div id="swimlaneView" class="active">
  ${swimlaneRows || '<div class="muted">No active feature branches found on the remote.</div>'}
</div>
<div id="kanbanView" class="kanban">
  ${kanbanCols}
</div>

<script>
  const vscode = acquireVsCodeApi();
  // JSON.stringify's own escaping already makes this valid JS to embed DIRECTLY as an
  // array literal (JSON syntax is a subset of JS expression syntax) — no surrounding
  // quotes, no JSON.parse() needed, so there's no outer string literal for a stray
  // apostrophe in a story ID or branch name to prematurely close. (A previous version
  // wrapped this in JSON.parse('...') — single-quoted — which broke outright the moment
  // any field contained a literal ' character, since only closing-script-tag-relevant
  // characters were escaped, never the quote the whole thing was wrapped in.) Escaping
  // <, >, & still guards against a closing script tag (or an HTML-entity-sensitive
  // character) inside a string value ending this script block early — note this comment
  // itself must never spell that literal tag out, or it would do exactly that.
  const CARDS = ${
      JSON.stringify(cards.map(c => ({
          id: c.storyId,
          branch: c.branch,
          stale: c.isStale,
          complete: c.isComplete,
          inactive: c.isInactive,
          lastActivity: c.lastActivity ?? "",
      }))).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")
  };

  let showComplete = false;
  let showInactive = false;

  // Safe DOM lookup by exact attribute value — avoids CSS selector injection
  // from story IDs that contain quotes or brackets.
  function cardsForStory(id) {
    return Array.from(document.querySelectorAll('[data-story]'))
      .filter(el => el.getAttribute('data-story') === id);
  }

  function setView(v) {
    document.getElementById('swimlaneView').className = v === 'swimlane' ? 'active' : '';
    document.getElementById('kanbanView').className   = v === 'kanban'   ? 'kanban active' : 'kanban';
    document.getElementById('btnSwimlane').className  = 'view-btn' + (v === 'swimlane' ? ' active' : '');
    document.getElementById('btnKanban').className    = 'view-btn' + (v === 'kanban'   ? ' active' : '');
  }

  function toggleShow(type) {
    if (type === 'complete') {
      showComplete = !showComplete;
      document.getElementById('btnComplete').classList.toggle('on', showComplete);
    } else {
      showInactive = !showInactive;
      document.getElementById('btnInactive').classList.toggle('on', showInactive);
    }
    applyFilter();
  }

  function applyFilter() {
    const q      = document.getElementById('searchBox').value.toLowerCase().trim();
    const days   = parseInt(document.getElementById('dateFilter').value || '0', 10);
    const stale  = document.getElementById('staleFilter').value;
    const cutoff = days ? Date.now() - days * 86400000 : 0;
    let visible  = 0;

    CARDS.forEach(c => {
      // A card is eligible to display if its toggle is on OR it is neither complete nor inactive.
      // A card that is BOTH complete and inactive is shown when EITHER toggle is on.
      const eligibleByToggle = (!c.complete && !c.inactive)
                             || (c.complete  && showComplete)
                             || (c.inactive  && showInactive);
      if (!eligibleByToggle) {
        cardsForStory(c.id).forEach(el => el.classList.add('hidden'));
        return;
      }
      const matchSearch = !q || c.id.toLowerCase().includes(q) || c.branch.toLowerCase().includes(q);
      const matchDate   = !cutoff || (c.lastActivity && new Date(c.lastActivity).getTime() >= cutoff);
      const matchStale  = !stale  || (stale === 'stale' ? c.stale : !c.stale);
      const show = matchSearch && matchDate && matchStale;
      if (show) { visible++; }
      cardsForStory(c.id).forEach(el => el.classList.toggle('hidden', !show));
    });
    document.getElementById('storyCount').textContent = visible + ' stor' + (visible === 1 ? 'y' : 'ies');
  }

  document.addEventListener('DOMContentLoaded', applyFilter);
  applyFilter();

  function refresh()             { vscode.postMessage({ command: 'refresh' }); }
  function openJourney(storyId)  { vscode.postMessage({ command: 'openJourney',   storyId }); }
  function markInactive(storyId) { vscode.postMessage({ command: 'markInactive', storyId }); }
  function markActive(storyId)   { vscode.postMessage({ command: 'markActive',   storyId }); }
</script>
</body>
</html>`;
    }

    private _relativeAge(iso: string): string {
        const ms  = Date.now() - new Date(iso).getTime();
        const d   = Math.floor(ms / (1000 * 60 * 60 * 24));
        const h   = Math.floor(ms / (1000 * 60 * 60));
        if (d >= 1)  { return `· ${d}d ago`; }
        if (h >= 1)  { return `· ${h}h ago`; }
        return "· just now";
    }
}

function escapeHtml(s: string): string {
    return s.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c));
}

/**
 * Safe for embedding inside a single-quoted JS string literal that itself sits inside a
 * double-quoted HTML attribute — the `onclick="fn('${...}')"` pattern used below.
 * escapeHtml alone doesn't cover this: it escapes `"` for the HTML *attribute*, but a raw
 * `'` in the value still closes the inline JS string early. Story IDs here can be a raw
 * branch name (extractStoryId falls back to the whole branch when it doesn't match the
 * configured ticket-key pattern — see below), not always something that went through
 * sanitizeStoryId, so this can't be assumed quote-free.
 *
 * Order matters: escape for the JS-string layer FIRST (backslash, then single quote —
 * backslash first so it isn't itself re-escaped by the quote step), THEN escapeHtml for
 * the HTML-attribute layer. The browser reverses this when parsing: it decodes the HTML
 * attribute first (turning `&quot;`/`&lt;`/`&gt;` back into literal `"`/`<`/`>`, which are
 * harmless *inside* a JS string), leaving valid JS with the `\'` still doing its job.
 */
function escapeForOnclickArg(s: string): string {
    return escapeHtml(s.replace(/\\/g, "\\\\").replace(/'/g, "\\'"));
}
