// StoryPipelinePanel.ts — Multi-story pipeline view.
// Shows every remote feature branch as a card positioned in the pipeline stage it has
// reached (Dev → QA → UAT → Prod). Two views: Swimlane (one row per environment) and
// Kanban (one column per environment). The user can toggle between them.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { getPromotableEnvironments, getPublishEnvironment, buildTicketUrl, featureBranchName, getStaleStoryThresholdDays } from "../config";
import { storyIdFromMessage } from "../DeploymentPlanner";
import { getTicketKeyPattern } from "../config";

interface StoryCard {
    storyId:      string;
    branch:       string;
    lastActivity: string | null;  // ISO 8601
    stageIndex:   number;         // -1 = feature-only, 0 = dev, 1+ = QA/UAT/Prod index
    stageName:    string;
    isStale:      boolean;
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
            "SF DevOps — Story Pipeline",
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

    private async _refresh(): Promise<void> {
        const cards = await this._buildCards();
        this._panel.webview.html = this._renderHtml(cards);
    }

    private async _buildCards(): Promise<StoryCard[]> {
        const envs      = getPromotableEnvironments();
        const devEnv    = getPublishEnvironment();
        const allEnvs   = [devEnv, ...envs];
        const pattern   = getTicketKeyPattern();
        const staleDay  = getStaleStoryThresholdDays();
        const now       = Date.now();

        // Build map: envName → set of story IDs that have been deployed there.
        // A story is "in" an env if its squash commit appears in that env's remote branch log.
        const deployedInEnv = new Map<string, Set<string>>();
        for (const env of allEnvs) {
            const ids = new Set<string>();
            try {
                const log = await this._gitHelper.commitLogBetweenRaw(
                    `origin/${env.branch}~500`, `origin/${env.branch}`
                ).catch(() => [] as { hash: string; date: string; author: string; message: string }[]);
                for (const c of log) {
                    const id = storyIdFromMessage(c.message, pattern);
                    if (id) { ids.add(id); }
                }
            } catch { /* env branch may not exist yet */ }
            deployedInEnv.set(env.name, ids);
        }

        const remoteBranches = await this._gitHelper.listRemoteFeatureBranches();
        const cards: StoryCard[] = [];

        for (const branch of remoteBranches) {
            // Extract story ID from branch name itself (same logic as isFeatureBranch).
            const branchTip = branch.split("/").pop() ?? branch;
            const storyId   = storyIdFromMessage(branchTip, pattern) ?? branchTip;
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

            const ageMs = lastActivity ? now - new Date(lastActivity).getTime() : 0;
            const isStale = staleDay > 0 && ageMs > staleDay * 24 * 60 * 60 * 1000;

            cards.push({ storyId, branch, lastActivity, stageIndex, stageName, isStale, ticketUrl });
        }

        // Sort: highest stage first, then most recently active.
        cards.sort((a, b) => {
            if (b.stageIndex !== a.stageIndex) { return b.stageIndex - a.stageIndex; }
            return (b.lastActivity ?? "").localeCompare(a.lastActivity ?? "");
        });

        return cards;
    }

    private _loadingHtml(): string {
        return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:24px;color:#888">Loading pipeline…</body></html>`;
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

        const cardHtml = (card: StoryCard) => {
            const age   = card.lastActivity
                ? `<span class="age">${this._relativeAge(card.lastActivity)}</span>`
                : "";
            const stale = card.isStale ? `<span class="stale-badge">stale</span>` : "";
            const link  = card.ticketUrl ? `<a href="${escapeHtml(card.ticketUrl)}" class="ticket-link">${escapeHtml(card.storyId)}</a>` : `<span class="story-id">${escapeHtml(card.storyId)}</span>`;
            return `<div class="card${card.isStale ? " stale" : ""}">
  <div class="card-head">${link}${stale}</div>
  <div class="card-meta">${escapeHtml(card.branch)}${age}</div>
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
<style>
  :root { --bg:#1e1e1e; --fg:#e0e0e0; --card:#252526; --border:#3c3c3c; --muted:#999; --accent:#4fc3f7; --ok:#7cd992; --warn:#ffab70; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#ffffff; --fg:#1a1a1a; --card:#f5f5f5; --border:#ddd; --muted:#666; --accent:#0078d4; --ok:#1b6b2f; --warn:#a05000; }
  }
  * { box-sizing: border-box; }
  body { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 16px 24px 60px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 16px; flex-wrap: wrap; }
  .view-btn { font-size: 12px; padding: 4px 12px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--fg); }
  .view-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .refresh-btn { font-size: 12px; padding: 4px 10px; border-radius: 5px; border: 1px solid var(--border); cursor: pointer; background: transparent; color: var(--muted); }
  .muted { color: var(--muted); font-size: 12px; }
  .count { font-size: 11px; background: var(--border); border-radius: 8px; padding: 1px 6px; }

  /* Swimlane */
  .swimlane { margin-bottom: 12px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .lane-label { padding: 7px 12px; font-weight: 600; font-size: 12px; background: color-mix(in srgb, var(--accent) 10%, var(--card)); border-bottom: 1px solid var(--border); }
  .lane-cards { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 12px; min-height: 52px; }

  /* Kanban */
  .kanban { display: flex; gap: 12px; overflow-x: auto; padding-bottom: 8px; }
  .kol { flex: 0 0 200px; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .kol-head { padding: 7px 10px; font-weight: 600; font-size: 12px; background: color-mix(in srgb, var(--accent) 10%, var(--card)); border-bottom: 1px solid var(--border); }
  .kol-body { padding: 8px; min-height: 80px; display: flex; flex-direction: column; gap: 6px; }

  /* Card */
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 7px 10px; font-size: 12px; min-width: 140px; }
  .card.stale { border-color: var(--warn); }
  .card-head { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
  .card-meta { color: var(--muted); font-size: 11px; margin-top: 3px; word-break: break-all; }
  .story-id { font-weight: 600; color: var(--accent); }
  .ticket-link { font-weight: 600; color: var(--accent); text-decoration: none; }
  .ticket-link:hover { text-decoration: underline; }
  .stale-badge { font-size: 10px; background: var(--warn); color: #fff; border-radius: 3px; padding: 0 4px; }
  .age { font-size: 10px; color: var(--muted); margin-left: 4px; }
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
  <span class="muted">${cards.length} active stor${cards.length === 1 ? "y" : "ies"}</span>
</div>

<div id="swimlaneView" class="active">
  ${swimlaneRows || '<div class="muted">No active feature branches found on the remote.</div>'}
</div>
<div id="kanbanView" class="kanban">
  ${kanbanCols}
</div>

<script>
  const vscode = acquireVsCodeApi();
  function setView(v) {
    document.getElementById('swimlaneView').className = v === 'swimlane' ? 'active' : '';
    document.getElementById('kanbanView').className   = v === 'kanban'   ? 'kanban active' : 'kanban';
    document.getElementById('btnSwimlane').className  = 'view-btn' + (v === 'swimlane' ? ' active' : '');
    document.getElementById('btnKanban').className    = 'view-btn' + (v === 'kanban'   ? ' active' : '');
  }
  function refresh() { vscode.postMessage({ command: 'refresh' }); }
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
