// AuditLog.ts — pure data model + rendering for the local audit trail.
// No fs/vscode dependency here; GitHelper.ts owns persistence (same pattern as the
// existing sf-devops-pending.json / sf-devops-coverage.json git-dir state).

export type AuditOperation =
    | "startStory"
    | "resumeStory"
    | "commitAndPublish"
    | "validate"
    | "promote"
    | "resumePromotion"
    | "cancelPromotion"
    | "syncBranch"
    | "prepare2gpBeta"
    | "runTests"
    | "deploy"
    | "deployValidate";

export type AuditOutcome = "success" | "conflict" | "failure";

export interface AuditChangedFile {
    path:   string;
    change: "added" | "modified" | "deleted";
}

export interface AuditDetails {
    commitMessage?:     string;
    changedFiles?:      AuditChangedFile[];
    packageXml?:        string;
    unmappedFiles?:     string[];
    conflicts?:         string[];
    error?:             string;
    prUrl?:             string;
    tag?:               string;
    version?:           string;
    releaseNotesPath?:  string;
    deployId?:          string;
    selectionMode?:     "all" | "stories" | "files";
    componentFailures?: { type: string; name: string; problem: string }[];
    testResults?: {
        passed:      boolean;
        threshold:   number;
        testsFailed: number;
        perClass:    { name: string; percent: number; pass: boolean }[];
    };
}

export interface AuditEntry {
    id:         string;
    timestamp:  string;
    operation:  AuditOperation;
    storyId?:   string;
    branch?:    string;
    targetEnv?: string;
    outcome:    AuditOutcome;
    summary:    string;
    details?:   AuditDetails;
}

const OPERATION_LABELS: Record<AuditOperation, string> = {
    startStory:       "Start New Story",
    resumeStory:      "Resume Previous Story",
    commitAndPublish: "Commit & Publish Feature Branch",
    validate:         "Validate Only",
    promote:          "Promote & Deploy",
    resumePromotion:  "Resume",
    cancelPromotion:  "Cancel",
    syncBranch:       "Sync Branch with Dev",
    prepare2gpBeta:   "Prepare 2GP Beta from UAT",
    runTests:         "Run Apex Tests",
    deploy:           "Deploy to Environment",
    deployValidate:   "Validate Deploy (dry-run)",
};

// Salesforce source-format folder name (under .../default/) → metadata API type.
// Covers the common cases; anything else is reported as "unmapped" rather than guessed.
const METADATA_TYPE_MAP: Record<string, string> = {
    classes:            "ApexClass",
    triggers:           "ApexTrigger",
    pages:              "ApexPage",
    components:         "ApexComponent",
    objects:            "CustomObject",
    layouts:            "Layout",
    flows:              "Flow",
    flexipages:         "FlowDefinition",
    lwc:                "LightningComponentBundle",
    aura:               "AuraDefinitionBundle",
    permissionsets:     "PermissionSet",
    profiles:           "Profile",
    staticresources:    "StaticResource",
    tabs:               "CustomTab",
    workflows:          "Workflow",
    email:              "EmailTemplate",
    labels:             "CustomLabels",
    remoteSiteSettings: "RemoteSiteSetting",
    customMetadata:     "CustomMetadata",
    reports:            "Report",
    dashboards:         "Dashboard",
    quickActions:       "QuickAction",
    globalValueSets:    "GlobalValueSet",
    namedCredentials:   "NamedCredential",
    connectedApps:      "ConnectedApp",
    sites:              "SiteDotCom",
    validationRules:    "ValidationRule",
    recordTypes:        "RecordType",
    listViews:          "ListView",
    webLinks:           "WebLink",
    fields:             "CustomField",
};

const DEFAULT_API_VERSION = "59.0";

/** Extracts the top-level metadata folder name (the segment right after ".../default/") from a source-format path. */
function metadataFolder(filePath: string): string | null {
    const parts = filePath.split("/");
    const idx = parts.indexOf("default");
    return idx !== -1 && parts.length > idx + 2 ? parts[idx + 1] : null;
}

function memberNameFromPath(filePath: string, folder: string): string {
    const parts = filePath.split("/");
    const idx = parts.indexOf(folder);
    const name = parts[idx + 1] ?? parts[parts.length - 1];
    return name.replace(/\.[^.]*(-meta\.xml)?$/i, "");
}

/**
 * Builds a Salesforce <Package> manifest from a set of changed files, grouping members
 * by inferred metadata type. Deleted files and files under an unrecognized folder are
 * called out separately rather than silently folded into the manifest.
 */
export function buildPackageXml(changedFiles: AuditChangedFile[]): { xml: string; unmapped: string[] } {
    const byType = new Map<string, Set<string>>();
    const unmapped: string[] = [];

    for (const f of changedFiles) {
        if (f.change === "deleted") { continue; } // real deletions belong in destructiveChanges.xml, not here
        const folder = metadataFolder(f.path);
        const type = folder ? METADATA_TYPE_MAP[folder] : undefined;
        if (!type) {
            unmapped.push(f.path);
            continue;
        }
        const member = memberNameFromPath(f.path, folder!);
        if (!byType.has(type)) { byType.set(type, new Set()); }
        byType.get(type)!.add(member);
    }

    const typesXml = Array.from(byType.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([type, members]) => {
            const membersXml = Array.from(members).sort()
                .map(m => `        <members>${escapeXml(m)}</members>`)
                .join("\n");
            return `    <types>\n${membersXml}\n        <name>${type}</name>\n    </types>`;
        })
        .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${typesXml}\n    <version>${DEFAULT_API_VERSION}</version>\n</Package>`;

    return { xml, unmapped };
}

function escapeXml(s: string): string {
    return s.replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]!));
}

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]!));
}

const OUTCOME_BADGE: Record<AuditOutcome, string> = {
    success:  "✅ Success",
    conflict: "⚠️ Conflict",
    failure:  "❌ Failure",
};

/** Lowercased blob of every searchable field on an entry, used for the free-text filter. */
function searchBlob(entry: AuditEntry): string {
    const d = entry.details ?? {};
    return [
        entry.timestamp, OPERATION_LABELS[entry.operation], entry.storyId, entry.branch, entry.targetEnv,
        entry.outcome, entry.summary, d.commitMessage, d.error, d.tag, d.version, d.prUrl,
        d.conflicts?.join(" "), d.changedFiles?.map(f => f.path).join(" "), d.deployId,
    ].filter(Boolean).join("   ").toLowerCase();
}

function renderEntry(entry: AuditEntry): string {
    const d = entry.details ?? {};
    const rows: string[] = [];

    if (entry.storyId)   { rows.push(row("Story", entry.storyId)); }
    if (entry.branch)    { rows.push(row("Branch", entry.branch)); }
    if (entry.targetEnv) { rows.push(row("Target env", entry.targetEnv)); }
    if (d.commitMessage) { rows.push(row("Commit message", d.commitMessage)); }
    if (d.version)        { rows.push(row("Version", d.version)); }
    if (d.tag)            { rows.push(row("Tag", d.tag)); }
    if (d.prUrl)          { rows.push(row("PR", `<a href="${escapeHtml(d.prUrl)}">${escapeHtml(d.prUrl)}</a>`)); }
    if (d.releaseNotesPath) { rows.push(row("Release notes", d.releaseNotesPath)); }
    if (d.error)          { rows.push(row("Error", `<span class="err">${escapeHtml(d.error)}</span>`)); }
    if (d.conflicts?.length) { rows.push(row("Conflicts", d.conflicts.map(escapeHtml).join(", "))); }
    if (d.deployId)        { rows.push(row("Deploy ID", d.deployId)); }
    if (d.selectionMode)   { rows.push(row("Selection", d.selectionMode)); }
    if (d.componentFailures?.length) {
        rows.push(row("Component failures", d.componentFailures.map(f => `${escapeHtml(f.type)}:${escapeHtml(f.name)} — ${escapeHtml(f.problem)}`).join("; ")));
    }

    if (d.testResults) {
        const t = d.testResults;
        rows.push(row("Test result", `${t.passed ? "passed" : "failed"} — threshold ${t.threshold}%, ${t.testsFailed} failing`));
        if (t.perClass.length) {
            const perClassRows = t.perClass
                .map(c => `<tr><td>${escapeHtml(c.name)}</td><td>${c.percent}%</td><td>${c.pass ? "✅" : "❌"}</td></tr>`)
                .join("");
            rows.push(`<tr><td colspan="2"><table class="inner"><tr><th>Class</th><th>Coverage</th><th></th></tr>${perClassRows}</table></td></tr>`);
        }
    }

    const detailBody = rows.length
        ? `<table class="kv">${rows.join("")}</table>`
        : `<div class="muted">No additional details.</div>`;

    const filesBlock = d.changedFiles?.length
        ? `<div class="section-title">Changed files</div><ul class="files">${
            d.changedFiles.map(f => `<li><span class="change ${f.change}">${f.change}</span> ${escapeHtml(f.path)}</li>`).join("")
          }</ul>`
        : "";

    const manifestBlock = d.packageXml
        ? `<div class="section-title">package.xml</div><pre class="manifest">${escapeHtml(d.packageXml)}</pre>${
            d.unmappedFiles?.length
                ? `<div class="muted">Not included in manifest (unrecognized metadata folder): ${d.unmappedFiles.map(escapeHtml).join(", ")}</div>`
                : ""
          }`
        : "";

    return `
<details class="entry outcome-${entry.outcome}"
          data-op="${escapeHtml(entry.operation)}"
          data-outcome="${escapeHtml(entry.outcome)}"
          data-search="${escapeHtml(searchBlob(entry))}">
  <summary>
    <span class="callout callout-${entry.outcome}"></span>
    <span class="ts">${escapeHtml(entry.timestamp)}</span>
    <span class="op">${escapeHtml(OPERATION_LABELS[entry.operation])}</span>
    ${entry.storyId ? `<span class="story">${escapeHtml(entry.storyId)}</span>` : ""}
    <span class="badge badge-${entry.outcome}">${OUTCOME_BADGE[entry.outcome]}</span>
    <span class="sum">${escapeHtml(entry.summary)}</span>
  </summary>
  <div class="body">
    ${detailBody}
    ${filesBlock}
    ${manifestBlock}
  </div>
</details>`;
}

function row(label: string, value: string): string {
    return `<tr><td class="k">${escapeHtml(label)}</td><td class="v">${value}</td></tr>`;
}

const OUTCOME_ORDER: AuditOutcome[] = ["success", "conflict", "failure"];

/** Renders the full self-contained audit trail HTML page (self-contained CSS + vanilla JS — this is opened as a plain local file in the OS browser, not a VS Code webview, so a <script> is safe and simplest). */
export function renderAuditHtml(entries: AuditEntry[]): string {
    const ordered = [...entries].reverse(); // newest first
    const body = ordered.length
        ? ordered.map(renderEntry).join("\n")
        : `<div class="muted" style="padding:24px">No operations recorded yet.</div>`;

    const opOptions = Object.entries(OPERATION_LABELS)
        .map(([key, label]) => `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`)
        .join("");

    const outcomePills = OUTCOME_ORDER
        .map(o => `<button type="button" class="pill pill-${o}" data-val="${o}">${OUTCOME_BADGE[o]}</button>`)
        .join("");

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>SF DevOps Audit Trail</title>
<style>
  :root {
    --bg: #ffffff; --fg: #1a1a1a; --card: #f5f5f5; --border: #ddd; --muted: #777;
    --accent: #0078d4; --err: #c62828;
    --ok-fg: #1b6b2f; --ok-bg: #e6f4ea;
    --warn-fg: #8a5a00; --warn-bg: #fff3d6;
    --err-fg: #a3251f; --err-bg: #fbe6e5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1e1e1e; --fg: #e0e0e0; --card: #2a2a2a; --border: #444; --muted: #999; --accent: #4fc3f7; --err: #ff6b6b;
      --ok-fg: #7cd992; --ok-bg: #17301f;
      --warn-fg: #ffcc66; --warn-bg: #3a2e10;
      --err-fg: #ff8a80; --err-bg: #3a1a18;
    }
  }
  *      { box-sizing: border-box; }
  body   { background: var(--bg); color: var(--fg); font-family: -apple-system, Segoe UI, sans-serif; font-size: 13px; margin: 0; padding: 16px; }
  h1     { font-size: 16px; margin: 0 0 12px; display: flex; align-items: baseline; gap: 10px; }
  #count { font-size: 12px; font-weight: 400; color: var(--muted); }

  /* ── Toolbar ─────────────────────────────────────────────────────────── */
  .toolbar {
    display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
    background: var(--card); border: 1px solid var(--border); border-radius: 8px;
    padding: 10px; margin-bottom: 14px; position: sticky; top: 0; z-index: 5;
  }
  .toolbar input[type="search"] {
    flex: 1 1 220px; min-width: 160px; padding: 6px 10px; border-radius: 6px;
    border: 1px solid var(--border); background: var(--bg); color: var(--fg); font-size: 13px;
  }
  .toolbar select {
    padding: 6px 8px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--bg); color: var(--fg); font-size: 12px;
  }
  .pills { display: flex; gap: 6px; }
  .pill {
    font-size: 11px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border);
    background: var(--bg); color: var(--fg); cursor: pointer; opacity: 0.6;
  }
  .pill:hover { opacity: 0.85; }
  .pill.active { opacity: 1; border-color: currentColor; }
  .pill-success { color: var(--ok-fg); }
  .pill-conflict { color: var(--warn-fg); }
  .pill-failure { color: var(--err-fg); }
  .btn {
    font-size: 12px; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border);
    background: var(--bg); color: var(--fg); cursor: pointer;
  }
  .btn:hover { border-color: var(--accent); }
  .toolbar .spacer { flex: 1 1 auto; }
  #emptyState { display: none; padding: 24px; color: var(--muted); text-align: center; }

  /* ── Entries ─────────────────────────────────────────────────────────── */
  .entry {
    background: var(--card); border: 1px solid var(--border); border-radius: 6px;
    margin-bottom: 8px; padding: 4px 10px 4px 0; overflow: hidden;
  }
  .entry.hidden { display: none; }
  summary { cursor: pointer; padding: 8px 4px 8px 0; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
  .callout {
    align-self: stretch; width: 4px; margin-right: 2px; border-radius: 2px; flex-shrink: 0;
  }
  .callout-success  { background: var(--ok-fg); }
  .callout-conflict { background: var(--warn-fg); }
  .callout-failure  { background: var(--err-fg); }
  .ts    { color: var(--muted); font-size: 11px; min-width: 150px; }
  .op    { font-weight: 600; }
  .story { color: var(--accent); font-weight: 600; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .badge-success  { background: var(--ok-bg); color: var(--ok-fg); }
  .badge-conflict { background: var(--warn-bg); color: var(--warn-fg); }
  .badge-failure  { background: var(--err-bg); color: var(--err-fg); }
  .sum   { color: var(--muted); font-size: 12px; }
  .body  { padding: 6px 4px 12px 14px; }
  table.kv { border-collapse: collapse; margin-bottom: 8px; }
  table.kv td { padding: 3px 8px; vertical-align: top; }
  table.kv td.k { color: var(--muted); white-space: nowrap; }
  table.inner { border-collapse: collapse; margin: 4px 0; }
  table.inner th, table.inner td { padding: 2px 8px; text-align: left; border-bottom: 1px solid var(--border); }
  .section-title { font-weight: 600; margin: 8px 0 4px; }
  ul.files { list-style: none; margin: 0; padding: 0; font-size: 12px; }
  ul.files li { padding: 2px 0; }
  .change { font-size: 10px; text-transform: uppercase; border-radius: 3px; padding: 1px 5px; margin-right: 6px; }
  .change.added { background: #2e7d3222; color: #4caf50; }
  .change.modified { background: #f9a82522; color: #ffa726; }
  .change.deleted { background: #c6282822; color: var(--err); }
  pre.manifest { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px; overflow-x: auto; font-size: 11px; }
  .muted { color: var(--muted); font-size: 12px; }
  .err   { color: var(--err); }
  mark   { background: #ffe08a; color: #1a1a1a; border-radius: 2px; padding: 0 1px; }
</style>
</head>
<body>
<h1>SF DevOps Audit Trail <span id="count"></span></h1>

<div class="toolbar">
  <input id="q" type="search" placeholder="Search summary, story, branch, error…  ( / to focus )" autocomplete="off">
  <select id="opFilter"><option value="">All operations</option>${opOptions}</select>
  <div class="pills" id="outcomeFilter">${outcomePills}</div>
  <div class="spacer"></div>
  <button type="button" class="btn" id="expandAll">Expand all</button>
  <button type="button" class="btn" id="collapseAll">Collapse all</button>
  <button type="button" class="btn" id="clearFilters">Clear filters</button>
</div>

<div id="entries">
${body}
</div>
<div id="emptyState">No entries match the current filters.</div>

<script>
(function () {
  var q = document.getElementById('q');
  var opFilter = document.getElementById('opFilter');
  var pills = Array.prototype.slice.call(document.querySelectorAll('#outcomeFilter .pill'));
  var entries = Array.prototype.slice.call(document.querySelectorAll('.entry'));
  var countEl = document.getElementById('count');
  var emptyEl = document.getElementById('emptyState');
  var total = entries.length;
  var activeOutcome = '';

  function highlight(term) {
    // Best-effort <mark> highlighting inside .sum / .story / .op — cleared and reapplied per filter pass.
    entries.forEach(function (el) {
      ['sum', 'story', 'op'].forEach(function (cls) {
        var node = el.querySelector('summary .' + cls);
        if (!node) { return; }
        var plain = node.getAttribute('data-plain') || node.textContent;
        node.setAttribute('data-plain', plain);
        if (!term) { node.textContent = plain; return; }
        var idx = plain.toLowerCase().indexOf(term);
        if (idx === -1) { node.textContent = plain; return; }
        node.textContent = '';
        node.appendChild(document.createTextNode(plain.slice(0, idx)));
        var m = document.createElement('mark');
        m.textContent = plain.slice(idx, idx + term.length);
        node.appendChild(m);
        node.appendChild(document.createTextNode(plain.slice(idx + term.length)));
      });
    });
  }

  function applyFilters() {
    var term = q.value.trim().toLowerCase();
    var op = opFilter.value;
    var shown = 0;
    entries.forEach(function (el) {
      var matchesTerm = !term || el.getAttribute('data-search').indexOf(term) !== -1;
      var matchesOp = !op || el.getAttribute('data-op') === op;
      var matchesOutcome = !activeOutcome || el.getAttribute('data-outcome') === activeOutcome;
      var visible = matchesTerm && matchesOp && matchesOutcome;
      el.classList.toggle('hidden', !visible);
      if (visible) { shown++; }
    });
    highlight(term);
    countEl.textContent = shown === total ? '(' + total + ')' : '(' + shown + ' of ' + total + ')';
    emptyEl.style.display = shown === 0 ? 'block' : 'none';
  }

  q.addEventListener('input', applyFilters);
  opFilter.addEventListener('change', applyFilters);
  pills.forEach(function (p) {
    p.addEventListener('click', function () {
      var val = p.getAttribute('data-val');
      activeOutcome = activeOutcome === val ? '' : val;
      pills.forEach(function (o) { o.classList.toggle('active', o === p && activeOutcome !== ''); });
      applyFilters();
    });
  });
  document.getElementById('clearFilters').addEventListener('click', function () {
    q.value = ''; opFilter.value = ''; activeOutcome = '';
    pills.forEach(function (o) { o.classList.remove('active'); });
    applyFilters();
  });
  document.getElementById('expandAll').addEventListener('click', function () {
    entries.forEach(function (el) { el.open = true; });
  });
  document.getElementById('collapseAll').addEventListener('click', function () {
    entries.forEach(function (el) { el.open = false; });
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); }
    if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; applyFilters(); q.blur(); }
  });

  applyFilters();
})();
</script>
</body>
</html>`;
}
