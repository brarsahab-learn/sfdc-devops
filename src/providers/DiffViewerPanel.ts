// DiffViewerPanel.ts
// Full-screen WebviewPanel that lists changed files between any two git branch refs
// (branch↔branch or branch↔org-state) and opens VS Code's native diff editor per file.

import * as vscode from "vscode";
import { GitHelper } from "../GitHelper";
import { getEnvironments, getPublishEnvironment } from "../config";
import { buildDiffUris } from "../DiffContentProvider";

function escHtml(s: string): string {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}

export class DiffViewerPanel {
    static readonly viewType = "sfDevopsDiffViewer";
    private static _current?: DiffViewerPanel;

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    static createOrShow(gitHelper: GitHelper, fromRef?: string, toRef?: string): void {
        const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
        if (DiffViewerPanel._current) {
            DiffViewerPanel._current._panel.reveal(column);
            DiffViewerPanel._current._initialize(gitHelper, fromRef, toRef);
            return;
        }
        const panel = vscode.window.createWebviewPanel(
            DiffViewerPanel.viewType,
            "Compare Branches",
            column,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        DiffViewerPanel._current = new DiffViewerPanel(panel, gitHelper, fromRef, toRef);
    }

    static refreshIfOpen(gitHelper: GitHelper): void {
        DiffViewerPanel._current?._initialize(gitHelper);
    }

    private constructor(
        panel: vscode.WebviewPanel,
        gitHelper: GitHelper,
        fromRef?: string,
        toRef?: string
    ) {
        this._panel = panel;

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async (msg: { command: string; fromRef?: string; toRef?: string; filePath?: string; pairs?: Array<{from:string;to:string}> }) => {
                if (msg.command === "loadDiff" && msg.fromRef && msg.toRef) {
                    await gitHelper.fetchOriginQuiet();
                    const files = await gitHelper.filesChangedBetween(msg.fromRef, msg.toRef).catch(() => []);
                    const warning = (files[0] as any)?._warning as string | undefined;
                    this._panel.webview.postMessage({
                        command: "diffLoaded",
                        files,
                        fromRef: msg.fromRef,
                        toRef: msg.toRef,
                        warning,
                    });
                } else if (msg.command === "loadPipeline" && msg.pairs) {
                    await gitHelper.fetchOriginQuiet();
                    const results = await Promise.all(
                        msg.pairs.map(async p => ({
                            from: p.from,
                            to:   p.to,
                            files: await gitHelper.filesChangedBetween(p.from, p.to).catch(() => []),
                        }))
                    );
                    this._panel.webview.postMessage({ command: "pipelineLoaded", results });
                } else if (msg.command === "openFileDiff" && msg.filePath && msg.fromRef && msg.toRef) {
                    const { before, after } = buildDiffUris(msg.filePath, msg.fromRef, msg.toRef);
                    const shortFrom = msg.fromRef.length > 20 ? msg.fromRef.slice(0, 20) + "…" : msg.fromRef;
                    const shortTo   = msg.toRef.length > 20   ? msg.toRef.slice(0, 20) + "…"   : msg.toRef;
                    const title = `${msg.filePath.split("/").pop()} (${shortFrom} ↔ ${shortTo})`;
                    await vscode.commands.executeCommand("vscode.diff", before, after, title);
                }
            },
            null,
            this._disposables
        );

        this._initialize(gitHelper, fromRef, toRef);
    }

    private async _initialize(gitHelper: GitHelper, fromRef?: string, toRef?: string): Promise<void> {
        const currentBranch = await gitHelper.currentBranch().catch(() => null);

        // Build ref list: current branch first, then all env branches in pipeline order
        const publishEnv = getPublishEnvironment();
        const allEnvs    = getEnvironments();
        const refs: { label: string; ref: string }[] = [];

        if (currentBranch) {
            refs.push({ label: `Current branch: ${currentBranch}`, ref: currentBranch });
        }
        for (const env of allEnvs) {
            refs.push({ label: env.label, ref: env.branch });
        }
        // Deduplicate (current branch might be an env branch)
        const seen = new Set<string>();
        const uniqueRefs = refs.filter(r => { if (seen.has(r.ref)) { return false; } seen.add(r.ref); return true; });

        const defaultFrom = fromRef ?? currentBranch ?? (uniqueRefs[0]?.ref ?? "");
        const defaultTo   = toRef   ?? publishEnv.branch ?? (uniqueRefs.find(r => r.ref !== defaultFrom)?.ref ?? "");

        // Build pipeline pairs: each consecutive env branch transition
        const pipelinePairs: Array<{ fromLabel: string; toLabel: string; from: string; to: string }> = [];
        if (currentBranch && !allEnvs.some(e => e.branch === currentBranch)) {
            const firstEnv = allEnvs[0];
            if (firstEnv) {
                pipelinePairs.push({ fromLabel: `Feature (${currentBranch})`, toLabel: firstEnv.label, from: currentBranch, to: firstEnv.branch });
            }
        }
        for (let i = 0; i < allEnvs.length - 1; i++) {
            pipelinePairs.push({ fromLabel: allEnvs[i].label, toLabel: allEnvs[i + 1].label, from: allEnvs[i].branch, to: allEnvs[i + 1].branch });
        }

        this._panel.title = "Compare Branches";
        this._panel.webview.html = this._buildHtml(uniqueRefs, defaultFrom, defaultTo, pipelinePairs);
    }

    private _buildHtml(
        refs: { label: string; ref: string }[],
        defaultFrom: string,
        defaultTo:   string,
        pipelinePairs: Array<{ fromLabel: string; toLabel: string; from: string; to: string }> = []
    ): string {
        const optionsJson = JSON.stringify(refs.map(r => ({ label: r.label, ref: r.ref })))
            .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
        const pairsJson = JSON.stringify(pipelinePairs)
            .replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");

        return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 16px; color: var(--vscode-foreground); }
  h2 { font-size: 14px; margin: 0 0 10px; }
  .tabs { display: flex; gap: 2px; margin-bottom: 14px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { padding: 5px 14px; cursor: pointer; font-size: 12px; border: 1px solid transparent; border-bottom: none; border-radius: 4px 4px 0 0; color: var(--vscode-tab-inactiveForeground); background: var(--vscode-tab-inactiveBackground); }
  .tab.active { color: var(--vscode-tab-activeForeground); background: var(--vscode-tab-activeBackground); border-color: var(--vscode-panel-border); border-bottom-color: var(--vscode-tab-activeBackground); }
  .tab-panel { display: none; }
  .tab-panel.active { display: block; }
  .info { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); border-radius: 4px; padding: 6px 10px; font-size: 11px; margin-bottom: 10px; }
  .picker-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; flex-wrap: wrap; }
  .picker-row select { flex: 1; min-width: 130px; max-width: 260px; padding: 5px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; font-size: 12px; font-family: inherit; }
  .picker-row .arrow { font-size: 16px; flex-shrink: 0; opacity: 0.7; }
  .btn { padding: 5px 11px; border: none; border-radius: 3px; cursor: pointer; font-size: 12px; font-family: inherit; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-primary:hover { background: var(--vscode-button-hoverBackground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .status-line { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; min-height: 20px; }
  .file-list { list-style: none; padding: 0; margin: 0; border: 1px solid var(--vscode-panel-border); border-radius: 4px; overflow: hidden; }
  .file-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; border-bottom: 1px solid var(--vscode-panel-border); }
  .file-item:last-child { border-bottom: none; }
  .file-item:hover { background: var(--vscode-list-hoverBackground); }
  .status-badge { font-size: 10px; font-weight: bold; padding: 1px 5px; border-radius: 3px; flex-shrink: 0; min-width: 14px; text-align: center; }
  .badge-added    { background: #2e7d32; color: #fff; }
  .badge-modified { background: var(--vscode-charts-blue, #1976d2); color: #fff; }
  .badge-deleted  { background: var(--vscode-charts-red, #c62828); color: #fff; }
  .badge-renamed  { background: var(--vscode-charts-yellow, #e65100); color: #fff; }
  .file-path { word-break: break-all; flex: 1; font-size: 11.5px; }
  .file-hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: auto; flex-shrink: 0; opacity: 0; }
  .file-item:hover .file-hint { opacity: 1; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 16px; text-align: center; }
  .legend { display: flex; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
  .legend-item { display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--vscode-descriptionForeground); }
  /* Pipeline tab */
  .stage-block { border: 1px solid var(--vscode-panel-border); border-radius: 4px; margin-bottom: 10px; overflow: hidden; }
  .stage-header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; cursor: pointer; background: var(--vscode-editor-background); user-select: none; }
  .stage-header:hover { background: var(--vscode-list-hoverBackground); }
  .stage-title { font-weight: 600; font-size: 12px; flex: 1; }
  .stage-count { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .stage-chevron { font-size: 10px; opacity: 0.6; }
  .stage-files { display: none; }
  .stage-files.open { display: block; }
  .loading-placeholder { padding: 8px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
<h2>🔍 Compare Branches</h2>

<div class="tabs">
  <div class="tab active" onclick="switchTab('compare')">Compare</div>
  <div class="tab" onclick="switchTab('pipeline')">Pipeline View</div>
</div>

<!-- Compare tab -->
<div id="tab-compare" class="tab-panel active">
  <div class="info">Pick two branches to see what files changed between them. Click any file to open a side-by-side diff.</div>
  <div class="picker-row">
    <select id="fromRef" onchange="onRefChange()"></select>
    <span class="arrow">→</span>
    <select id="toRef" onchange="onRefChange()"></select>
    <button class="btn btn-secondary" onclick="swapRefs()" title="Swap from/to">⇄</button>
    <button class="btn btn-primary" id="compareBtn" onclick="loadDiff()">Compare</button>
  </div>
  <div class="legend" id="legend" style="display:none">
    <div class="legend-item"><span class="status-badge badge-added">A</span> Added</div>
    <div class="legend-item"><span class="status-badge badge-modified">M</span> Modified</div>
    <div class="legend-item"><span class="status-badge badge-deleted">D</span> Deleted</div>
    <div class="legend-item"><span class="status-badge badge-renamed">R</span> Renamed</div>
  </div>
  <div class="status-line" id="statusLine"></div>
  <div id="warningLine" style="display:none;font-size:11px;color:var(--vscode-notificationsWarningIcon-foreground);margin-bottom:6px;padding:4px 8px;background:var(--vscode-inputValidation-warningBackground);border-radius:3px;"></div>
  <ul id="fileList" class="file-list" style="display:none"></ul>
</div>

<!-- Pipeline tab -->
<div id="tab-pipeline" class="tab-panel">
  <div class="info">Each row shows what files differ between consecutive pipeline stages. Click a row to expand, then click a file to diff it.</div>
  <div id="pipelineBlocks"></div>
</div>

<script>
  const vscode = acquireVsCodeApi();
  const REFS         = JSON.parse('${optionsJson}');
  const PIPELINE_PAIRS = JSON.parse('${pairsJson}');
  const DEFAULT_FROM = ${JSON.stringify(defaultFrom)};
  const DEFAULT_TO   = ${JSON.stringify(defaultTo)};

  let _currentFrom = DEFAULT_FROM;
  let _currentTo   = DEFAULT_TO;
  let _pipelineLoaded = false;

  function esc(s) {
    return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
  }

  /* ── Tabs ── */
  function switchTab(tab) {
    document.querySelectorAll('.tab').forEach((el, i) => {
      el.classList.toggle('active', (i === 0 && tab === 'compare') || (i === 1 && tab === 'pipeline'));
    });
    document.getElementById('tab-compare').classList.toggle('active', tab === 'compare');
    document.getElementById('tab-pipeline').classList.toggle('active', tab === 'pipeline');
    if (tab === 'pipeline' && !_pipelineLoaded) { loadPipeline(); }
  }

  /* ── Compare tab ── */
  function buildOptions() {
    return REFS.map(r => '<option value="' + esc(r.ref) + '">' + esc(r.label) + '</option>').join('');
  }

  const fromEl    = document.getElementById('fromRef');
  const toEl      = document.getElementById('toRef');
  const listEl    = document.getElementById('fileList');
  const statusEl  = document.getElementById('statusLine');
  const legendEl  = document.getElementById('legend');
  const warnEl    = document.getElementById('warningLine');

  function renderSelects() {
    fromEl.innerHTML = buildOptions();
    toEl.innerHTML   = buildOptions();
    fromEl.value = _currentFrom;
    toEl.value   = _currentTo;
  }

  function onRefChange() {
    _currentFrom = fromEl.value;
    _currentTo   = toEl.value;
  }

  function swapRefs() {
    const tmp = _currentFrom;
    _currentFrom = _currentTo;
    _currentTo = tmp;
    renderSelects();
    loadDiff();
  }

  function loadDiff() {
    _currentFrom = fromEl.value;
    _currentTo   = toEl.value;
    listEl.style.display = 'none';
    legendEl.style.display = 'none';
    warnEl.style.display = 'none';
    listEl.innerHTML = '';
    if (!_currentFrom || !_currentTo) { statusEl.textContent = 'Select both branches.'; return; }
    if (_currentFrom === _currentTo)  { statusEl.textContent = 'Select two different branches.'; return; }
    statusEl.textContent = '⏳ Fetching latest refs and loading changed files…';
    vscode.postMessage({ command: 'loadDiff', fromRef: _currentFrom, toRef: _currentTo });
  }

  /* ── Pipeline tab ── */
  function loadPipeline() {
    _pipelineLoaded = true;
    const container = document.getElementById('pipelineBlocks');
    if (PIPELINE_PAIRS.length === 0) {
      container.innerHTML = '<div class="empty">No pipeline stages configured.</div>';
      return;
    }
    // Render skeleton blocks with loading placeholders
    container.innerHTML = PIPELINE_PAIRS.map((p, i) =>
      '<div class="stage-block" id="sb'+i+'">' +
        '<div class="stage-header" onclick="toggleStage('+i+')">' +
          '<span class="stage-chevron" id="chev'+i+'">▶</span>' +
          '<span class="stage-title">' + esc(p.fromLabel) + ' → ' + esc(p.toLabel) + '</span>' +
          '<span class="stage-count" id="cnt'+i+'">loading…</span>' +
        '</div>' +
        '<div class="stage-files" id="sf'+i+'">' +
          '<div class="loading-placeholder">Loading…</div>' +
        '</div>' +
      '</div>'
    ).join('');

    vscode.postMessage({ command: 'loadPipeline', pairs: PIPELINE_PAIRS.map(p => ({ from: p.from, to: p.to })) });
  }

  function toggleStage(i) {
    const el = document.getElementById('sf'+i);
    const chev = document.getElementById('chev'+i);
    const open = el.classList.toggle('open');
    chev.textContent = open ? '▼' : '▶';
  }

  function renderFileList(files, fromRef, toRef) {
    if (files.length === 0) { return '<ul class="file-list"><li class="empty">No differences — branches are in sync.</li></ul>'; }
    return '<ul class="file-list">' + files.map(f => {
      const badgeClass = 'badge-' + f.status;
      const label = f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'renamed' ? 'R' : 'M';
      const displayPath = (f.status === 'renamed' && f.oldPath)
        ? esc(f.oldPath) + ' <span style="opacity:0.6">→</span> ' + esc(f.path)
        : esc(f.path);
      return '<li class="file-item" onclick="openDiff(\\''+esc(f.path)+'\\',\\''+esc(fromRef)+'\\',\\''+esc(toRef)+'\\')">' +
             '<span class="status-badge ' + badgeClass + '">' + label + '</span>' +
             '<span class="file-path">' + displayPath + '</span>' +
             '<span class="file-hint">Open diff ↗</span></li>';
    }).join('') + '</ul>';
  }

  /* ── Message handler ── */
  window.addEventListener('message', e => {
    const msg = e.data;
    if (msg.command === 'diffLoaded') {
      const files = msg.files || [];
      if (msg.warning) {
        warnEl.textContent = '⚠ ' + msg.warning;
        warnEl.style.display = 'block';
      }
      if (files.length === 0) {
        statusEl.textContent = '';
        listEl.innerHTML = '<li class="empty">No changed files between these two branches.</li>';
        listEl.style.display = 'block';
        return;
      }
      const fromLabel = REFS.find(r => r.ref === msg.fromRef)?.label ?? msg.fromRef;
      const toLabel   = REFS.find(r => r.ref === msg.toRef)?.label ?? msg.toRef;
      statusEl.textContent = files.length + ' file(s) changed — ' + fromLabel + ' → ' + toLabel;
      legendEl.style.display = 'flex';
      listEl.innerHTML = files.map(f => {
        const badgeClass = 'badge-' + f.status;
        const label = f.status === 'added' ? 'A' : f.status === 'deleted' ? 'D' : f.status === 'renamed' ? 'R' : 'M';
        const displayPath = (f.status === 'renamed' && f.oldPath)
          ? esc(f.oldPath) + ' <span style="opacity:0.6">→</span> ' + esc(f.path)
          : esc(f.path);
        return '<li class="file-item" onclick="openDiff(\\''+esc(f.path)+'\\',\\''+esc(msg.fromRef)+'\\',\\''+esc(msg.toRef)+'\\')">' +
               '<span class="status-badge ' + badgeClass + '">' + label + '</span>' +
               '<span class="file-path">' + displayPath + '</span>' +
               '<span class="file-hint">Open diff ↗</span></li>';
      }).join('');
      listEl.style.display = 'block';
    } else if (msg.command === 'pipelineLoaded') {
      msg.results.forEach((r, i) => {
        const cnt  = document.getElementById('cnt'+i);
        const sf   = document.getElementById('sf'+i);
        if (cnt) { cnt.textContent = r.files.length + ' file(s) different'; }
        if (sf)  { sf.innerHTML = renderFileList(r.files, r.from, r.to); }
      });
    }
  });

  function openDiff(filePath, fromRef, toRef) {
    vscode.postMessage({ command: 'openFileDiff', filePath, fromRef, toRef });
  }

  // Initialize compare tab
  renderSelects();
  loadDiff();
</script>
</body>
</html>`;
    }

    dispose(): void {
        DiffViewerPanel._current = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
        this._disposables = [];
    }
}
