# SF DevOps — Plan 3: Admin Experience

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stale story detection, a Lead/Admin "pending actions" quick view, environment locking, comprehensive audit trail management, and a full Admin panel replacing the cramped Setup Check sidebar.

**Architecture:** Plan 1 must be complete before starting this plan (AdminPanel's Role & Security tab depends on per-role secrets). One new file: `AdminPanel.ts`. `AuditTrailPanel.ts` and `StoryWebviewProvider.ts` get significant updates.

**Tech Stack:** TypeScript, VS Code Extension API, HTML/CSS in webview strings

**Spec:** `docs/superpowers/specs/2026-09-04-sf-devops-prelaunch-hardening-design.md` §4

## Global Constraints

- `npm run compile` must pass with zero errors after every task
- No new npm dependencies
- `escapeHtml()` must wrap every user-supplied string interpolated into webview HTML
- Compile command: `npm run compile`
- Manual test: F5 launches Extension Development Host

---

### Task 1: Stale Story Detection

**Files:**
- Modify: `src/GitHelper.ts` (add `branchLastCommitAge` if not added in Plan 2 Task 5)
- Modify: `src/config.ts` (add `getStaleStoryThresholdDays`)
- Modify: `src/providers/StoryWebviewProvider.ts` (stale banner in `_getWebviewHtml`)
- Modify: `package.json` (add `sfDevops.staleStoryThresholdDays` setting)

**Interfaces:**
- Produces: `config.getStaleStoryThresholdDays(): number`
- Produces: `GitHelper.branchAgeDays(branch: string): Promise<number>`

- [ ] **Step 1: Add `getStaleStoryThresholdDays` to config.ts**

In `src/config.ts`, add after `getStaleBranchThreshold`:

```typescript
/** Days with no new commits before a story is flagged stale. 0 = disabled. */
export function getStaleStoryThresholdDays(): number {
    return cfg().get<number>("staleStoryThresholdDays") ?? 14;
}
```

- [ ] **Step 2: Add `branchAgeDays` to GitHelper.ts**

If Plan 2 Task 5 already added `branchLastCommitTimestamp`, add a wrapper:

```typescript
/** Returns how many days ago the last commit on this branch was made. Returns 0 if unknown. */
async branchAgeDays(branch: string): Promise<number> {
    const ts = await this.branchLastCommitTimestamp(branch);
    if (ts <= 0) { return 0; }
    return Math.floor((Date.now() / 1000 - ts) / 86400);
}
```

If `branchLastCommitTimestamp` does not exist yet (Plan 2 not done), add it too:

```typescript
async branchLastCommitTimestamp(branch: string): Promise<number> {
    try {
        const out = await this.git(["log", "--max-count=1", "--format=%ct", branch]);
        return parseInt(out.trim(), 10) || 0;
    } catch {
        return 0;
    }
}
```

- [ ] **Step 3: Add stale detection to StoryWebviewProvider.refresh()**

In `src/providers/StoryWebviewProvider.ts`, in `refresh()`, after the `onFeatureBranch` check, add:

```typescript
const staleThreshold = getStaleStoryThresholdDays();
let isStoryStale = false;
let storyAgeDays = 0;
if (onFeatureBranch && staleThreshold > 0 && storyId) {
    storyAgeDays = await this._gitHelper.branchAgeDays(branch!);
    isStoryStale = storyAgeDays >= staleThreshold;
}
```

Pass `isStoryStale` and `storyAgeDays` to `_getWebviewHtml` as new parameters, or derive them inside. The simplest approach: pass `isStoryStale: boolean` and `storyAgeDays: number` as two new trailing params.

Update `_getWebviewHtml` signature to add:
```typescript
isStoryStale: boolean,
storyAgeDays: number
```

- [ ] **Step 4: Add stale banner to `_getWebviewHtml`**

In `_getWebviewHtml`, compute `staleBanner` from the new params:

```typescript
const staleNotice = (isStoryStale && onFeatureBranch && storyId)
    ? `<div class="warning">⏰ ${escapeHtml(storyId)} has had no new commits in ${storyAgeDays} day(s) — is this story still active? <a href="#" onclick="send('dismissStale')">Dismiss</a></div>`
    : "";
```

Add `${staleNotice}` below `${externalSwitchNotice}` in the HTML body.

Handle `dismissStale` in `onDidReceiveMessage`:
```typescript
case "dismissStale":
    if (storyId) {
        await this._extContext.workspaceState.update(`sfDevops.staleDismissed.${storyId}`, true);
        this.refresh();
    }
    break;
```

In `refresh()`, after computing `isStoryStale`, check the dismiss state:
```typescript
if (isStoryStale) {
    const dismissed = this._extContext.workspaceState.get<boolean>(`sfDevops.staleDismissed.${storyId}`, false);
    isStoryStale = !dismissed;
}
```

Clear dismiss state when a new commit is detected (branch SHA changes). Add to `refresh()` after `this._noteBranchForExternalSwitchDetection`:
```typescript
// Clear stale dismissal when the branch's remote SHA advances
const currentRemoteSha = await this._gitHelper.remoteHeadSha(branch!).catch(() => null);
const lastSha = this._extContext.workspaceState.get<string>(`sfDevops.lastSha.${storyId}`);
if (currentRemoteSha && currentRemoteSha !== lastSha) {
    await this._extContext.workspaceState.update(`sfDevops.staleDismissed.${storyId}`, false);
    await this._extContext.workspaceState.update(`sfDevops.lastSha.${storyId}`, currentRemoteSha);
}
```

- [ ] **Step 5: Add `sfDevops.staleStoryThresholdDays` to package.json**

In `"contributes"."configuration"."properties"`:

```json
"sfDevops.staleStoryThresholdDays": {
    "type": "number",
    "description": "Days with no new commits before a story is flagged as stale in the Current Story panel and Pipeline view. Set to 0 to disable stale detection.",
    "default": 14
}
```

Also add the import for `getStaleStoryThresholdDays` to `StoryWebviewProvider.ts`:
```typescript
import { ..., getStaleStoryThresholdDays } from "../config";
```

- [ ] **Step 6: Compile**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 7: Manual verification**

Launch Extension Development Host. Temporarily set `sfDevops.staleStoryThresholdDays` to `1` in settings. Check out a feature branch with its last commit > 1 day ago. Verify the stale warning banner appears. Click Dismiss — verify it disappears and doesn't re-appear on manual Refresh.

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/GitHelper.ts src/providers/StoryWebviewProvider.ts package.json
git commit -m "feat: stale story detection with dismissable banner in Current Story panel"
```

---

### Task 2: "Stories Pending My Action" — Lead/Admin QuickPick

**Files:**
- Modify: `src/extension.ts` (register `sfDevops.viewPendingActions`)
- Modify: `src/providers/StoryWebviewProvider.ts` (add `⚡ Actions` link to more-actions footer)
- Modify: `package.json` (add command)

**Interfaces:**
- Consumes: `listFeatureBranches`, `listRemoteFeatureBranches` (from Plan 2 Task 5 / this plan Task 1), `getStoryProgress`, `canPromote`, `getEffectiveRole`, `getPromotableEnvironments`

- [ ] **Step 1: Implement `sfDevops.viewPendingActions` in extension.ts**

In `src/extension.ts`, add inside `context.subscriptions.push(...)`:

```typescript
vscode.commands.registerCommand("sfDevops.viewPendingActions", async () => {
    const role = getEffectiveRole(context);
    const promotable = getPromotableEnvironments();
    const promotableForRole = promotable.filter(e => canPromote(role, e));

    if (promotableForRole.length === 0) {
        vscode.window.showInformationMessage("Your current role has no environments to promote or deploy into.");
        return;
    }

    const localBranches  = await gitHelper.listFeatureBranches();
    const remoteBranches = await gitHelper.listRemoteFeatureBranches().catch(() => [] as string[]);
    const allBranches    = [...new Set([...localBranches, ...remoteBranches])];

    interface ActionItem extends vscode.QuickPickItem {
        envName: string;
        storyId: string;
    }

    const items: ActionItem[] = [];
    for (const branch of allBranches) {
        const storyId  = extractStoryId(branch) || branch;
        const progress = await getStoryProgress(gitHelper, bbClient, storyId).catch(() => ({}));
        for (const env of promotableForRole) {
            const state = progress[env.name];
            let action = "";
            if (state === "merged")  { action = `Deploy to ${env.label}`; }
            else if (state === "open") { action = `Review PR → ${env.label}`; }
            else if (state === "published" && env === promotable[0]) { action = `Promote to ${env.label}`; }
            if (!action) { continue; }
            items.push({
                label:       `$(arrow-right) ${storyId}`,
                description: action,
                detail:      `Branch: ${branch}`,
                envName:     env.name,
                storyId,
            });
        }
    }

    if (items.length === 0) {
        vscode.window.showInformationMessage("No stories are currently waiting for your action.");
        return;
    }

    const picked = await vscode.window.showQuickPick(items, {
        title: `Pending Actions (${role})`,
        placeHolder: "Select a story to act on",
        matchOnDescription: true,
    });
    if (!picked) { return; }

    const state = await getStoryProgress(gitHelper, bbClient, picked.storyId)
        .then(p => p[picked.envName]).catch(() => "");

    if (state === "merged") {
        await vscode.commands.executeCommand("sfDevops.openDeploymentDashboard", picked.envName);
    } else {
        await vscode.commands.executeCommand("sfDevops.promoteEnv", picked.envName);
    }
}),
```

Add the `getStoryProgress` import to `extension.ts`:
```typescript
import { getStoryProgress } from "./StoryProgress";
```

Also ensure `getPromotableEnvironments`, `extractStoryId` are in the config import.

- [ ] **Step 2: Add `⚡ Actions` link to StoryWebviewProvider footer**

In `src/providers/StoryWebviewProvider.ts`, in `_getWebviewHtml`, update `moreActions` to include the Actions link (shown only for Lead/Admin):

```typescript
const pendingActionsLink = (this._userRole === "Developer")
    ? ""
    : `<a href="#" onclick="send('viewPendingActions')">⚡ Actions</a> · `;

const moreActions = `<div class="more-actions">
    ${pendingActionsLink}
    ${onFeatureBranch && devPublished ? `<a href="#" onclick="send('commitAndPush')">☁ Publish more changes</a> · ` : ""}
    ${onFeatureBranch ? `<a href="#" onclick="send('syncBranch')">🔄 Sync with ${baseBranch}</a> · ` : ""}
    <a href="#" onclick="send('openPipeline')">📊 Pipeline</a>
  </div>`;
```

Handle `viewPendingActions` in `onDidReceiveMessage`:
```typescript
case "viewPendingActions":
    vscode.commands.executeCommand("sfDevops.viewPendingActions"); break;
```

- [ ] **Step 3: Add command to package.json**

```json
{
    "command": "sfDevops.viewPendingActions",
    "title": "View Pending Actions",
    "icon": "$(zap)",
    "category": "Salesforce DevOps"
}
```

- [ ] **Step 4: Compile**

```bash
npm run compile
```

- [ ] **Step 5: Manual verification**

Set role to Lead. Run Command Palette → "View Pending Actions". Verify it lists stories with merged/open PR states for UAT (the Lead-accessible env). Select one — confirm it opens the Deployment Dashboard or promote picker for that env.

- [ ] **Step 6: Commit**

```bash
git add src/extension.ts src/providers/StoryWebviewProvider.ts package.json
git commit -m "feat: pending actions QuickPick for Lead and Admin roles"
```

---

### Task 3: Environment Locked Flag

**Files:**
- Modify: `src/config.ts` (add `locked` to `EnvironmentSetting`/`ResolvedEnvironment`, update `canPromote`)
- Modify: `src/providers/EnvironmentTreeProvider.ts` (show locked state in tree)
- Modify: `package.json` (add `environments[].locked` to schema)

**Interfaces:**
- Produces: `ResolvedEnvironment.locked: boolean` — consumed by `canPromote`, env tree, pipeline panel, deploy dashboard

- [ ] **Step 1: Add `locked` to EnvironmentSetting and ResolvedEnvironment in config.ts**

In `src/config.ts`, in `EnvironmentSetting`:
```typescript
export interface EnvironmentSetting {
    name:         string;
    label?:       string;
    branch?:      string;
    icon?:        string;
    requiredRole?: string;
    coverageGate?: boolean;
    signoffGate?: boolean;
    orgAlias?:    string;
    deployTestLevel?: string;
    isProd?:      boolean;
    locked?:      boolean;  // NEW
}
```

In `ResolvedEnvironment`:
```typescript
export interface ResolvedEnvironment {
    name:         string;
    label:        string;
    branch:       string;
    icon:         string;
    requiredRole?: string;
    coverageGate: boolean;
    signoffGate:  boolean;
    orgAlias?:    string;
    deployTestLevel: string;
    isProd:       boolean;
    locked:       boolean;  // NEW
}
```

In `getEnvironments()`, in the `.map()` return object, add:
```typescript
locked: e.locked ?? false,
```

- [ ] **Step 2: Update `canPromote` to check `locked`**

In `src/config.ts`, update `canPromote`:

```typescript
export function canPromote(role: string, env: ResolvedEnvironment): boolean {
    if (env.locked) { return false; }  // locked beats all roles
    if (!env.requiredRole) { return true; }
    const roles = getRoles();
    const requiredRank = roles.indexOf(env.requiredRole);
    if (requiredRank === -1) { return role === env.requiredRole; }
    return roles.indexOf(role) >= requiredRank;
}
```

- [ ] **Step 3: Show locked state in EnvironmentTreeProvider**

In `src/providers/EnvironmentTreeProvider.ts`, in the `EnvItem` constructor, after building `this.description`, add a locked check:

```typescript
if (env.locked) {
    this.iconPath = new vscode.ThemeIcon("lock");
    this.description = `🔴 Locked — ${this.description}`;
    this.tooltip = `⛔ This environment is locked by Admin — no promotions or deploys allowed.\n${this.tooltip}`;
}
```

Add this block right before the closing `}` of the constructor.

- [ ] **Step 4: Add `environments[].locked` to package.json schema**

In the `sfDevops.environments` items `anyOf[1].properties` object, add:

```json
"locked": {
    "type": "boolean",
    "description": "When true, blocks all promotions and deploys into this environment for all roles including Admin. Use for emergency stops."
}
```

- [ ] **Step 5: Compile**

```bash
npm run compile
```

- [ ] **Step 6: Manual verification**

Add `"locked": true` to the QA entry in settings. Verify Promote to QA button is disabled/hidden and the tree item shows the lock icon. Remove the flag — verify normal behaviour returns.

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/providers/EnvironmentTreeProvider.ts package.json
git commit -m "feat: environment locked flag — Admin can block all promotions per environment"
```

---

### Task 4: Audit Trail Management

**Files:**
- Modify: `src/providers/AuditTrailPanel.ts`
- Modify: `src/GitHelper.ts` (add `trimAuditLog`, `getAuditLogSizeBytes`)
- Modify: `src/config.ts` (add `getAuditLogRetentionDays`)
- Modify: `src/extension.ts` (auto-trim on startup)
- Modify: `package.json` (add `sfDevops.auditLogRetentionDays` setting)

**Interfaces:**
- Produces: `GitHelper.trimAuditLog(olderThanMs: number): Promise<number>` — returns count of removed entries
- Produces: `GitHelper.getAuditLogSizeBytes(): Promise<number>`
- Produces: `config.getAuditLogRetentionDays(): number`

- [ ] **Step 1: Add `getAuditLogRetentionDays` to config.ts**

```typescript
/** Auto-trim audit entries older than this many days on startup. 0 = disabled. */
export function getAuditLogRetentionDays(): number {
    return cfg().get<number>("auditLogRetentionDays") ?? 90;
}
```

- [ ] **Step 2: Add `trimAuditLog` and `getAuditLogSizeBytes` to GitHelper.ts**

Find how the audit log file is read in GitHelper (look for the existing `appendAudit` method and its file path). Add two new methods alongside:

```typescript
/**
 * Removes audit entries older than `olderThanMs` milliseconds from the current time.
 * Returns the count of removed entries.
 */
async trimAuditLog(olderThanMs: number): Promise<number> {
    const auditPath = this.auditLogPath(); // use the same private helper appendAudit uses
    try {
        const raw = fs.readFileSync(auditPath, "utf8");
        const entries: any[] = JSON.parse(raw);
        const cutoff = Date.now() - olderThanMs;
        const kept = entries.filter(e => {
            const ts = new Date(e.timestamp ?? 0).getTime();
            return ts >= cutoff;
        });
        if (kept.length === entries.length) { return 0; }
        fs.writeFileSync(auditPath, JSON.stringify(kept, null, 2), "utf8");
        return entries.length - kept.length;
    } catch {
        return 0;
    }
}

/** Returns the file size of the audit log in bytes, or 0 if not present. */
async getAuditLogSizeBytes(): Promise<number> {
    const auditPath = this.auditLogPath();
    try {
        return fs.statSync(auditPath).size;
    } catch {
        return 0;
    }
}
```

Note: `this.auditLogPath()` — find the private method or inline constant that `appendAudit` uses for the file path and use the same one. It will be something like `path.join(this.getGitDir(), "sf-devops-audit.json")`.

- [ ] **Step 3: Auto-trim on activation in extension.ts**

In `activate()`, after `initOrgAliasStore(context)`, add:

```typescript
// Auto-trim audit log on startup if retention is configured
const retentionDays = getAuditLogRetentionDays();
if (retentionDays > 0) {
    const olderThanMs = retentionDays * 24 * 60 * 60 * 1000;
    const trimmed = await gitHelper.trimAuditLog(olderThanMs);
    if (trimmed > 0) {
        log(`Auto-trimmed ${trimmed} audit entries older than ${retentionDays} days.`);
    }
}
```

Add `getAuditLogRetentionDays` to the config import in `extension.ts`.

- [ ] **Step 4: Add `sfDevops.auditLogRetentionDays` to package.json**

```json
"sfDevops.auditLogRetentionDays": {
    "type": "number",
    "description": "Auto-trim audit log entries older than this many days on extension startup. Set to 0 to disable auto-trim.",
    "default": 90
}
```

- [ ] **Step 5: Rewrite AuditTrailPanel to add filter bar, scoped export, and lifecycle controls**

`AuditTrailPanel.ts` currently renders a simple read-only log. Read the existing file to understand the current structure, then add these capabilities. The key additions to the webview HTML:

**Filter bar (top):**
```html
<div class="filter-bar">
  <select id="dateFilter" onchange="applyFilters()">
    <option value="7">Last 7 days</option>
    <option value="30">Last 30 days</option>
    <option value="90" selected>Last 90 days</option>
    <option value="0">All time</option>
  </select>
  <select id="opFilter" onchange="applyFilters()">
    <option value="">All operations</option>
    <option value="deploy">Deploy</option>
    <option value="validate">Validate</option>
    <option value="promote">Promote</option>
    <option value="commitAndPublish">Commit & Publish</option>
    <option value="startStory">Start Story</option>
    <option value="signoff">Sign-off</option>
    <option value="changeRole">Role Change</option>
  </select>
  <select id="outcomeFilter" onchange="applyFilters()">
    <option value="">All outcomes</option>
    <option value="success">Success</option>
    <option value="failure">Failure</option>
    <option value="conflict">Conflict</option>
  </select>
  <input type="text" id="storyFilter" placeholder="Story ID…" oninput="applyFilters()">
</div>
```

**Toolbar buttons (Admin-only):**
```html
<div class="audit-toolbar">
  <button onclick="send('export')">⬇ Export</button>
  ${isAdmin ? `
    <button onclick="send('trim')">🗑 Trim</button>
    <button onclick="send('archiveAndTrim')">📦 Archive & Trim</button>
    <button onclick="send('clearAll')" class="danger-btn">🗑 Clear All</button>
  ` : ""}
</div>
```

**Client-side filtering JS:**
```javascript
let allEntries = []; // populated from data attribute on body or a JSON script tag

function applyFilters() {
    const days    = parseInt(document.getElementById('dateFilter').value, 10);
    const op      = document.getElementById('opFilter').value;
    const outcome = document.getElementById('outcomeFilter').value;
    const story   = document.getElementById('storyFilter').value.toLowerCase();
    const cutoff  = days > 0 ? Date.now() - days * 86400000 : 0;

    const filtered = allEntries.filter(e => {
        const ts = new Date(e.timestamp ?? 0).getTime();
        if (days > 0 && ts < cutoff) { return false; }
        if (op && e.operation !== op) { return false; }
        if (outcome && e.outcome !== outcome) { return false; }
        if (story && !(e.storyId ?? "").toLowerCase().includes(story)) { return false; }
        return true;
    });
    renderEntries(filtered);
    document.getElementById('filteredCount').textContent = `${filtered.length} of ${allEntries.length} entries`;
}
```

**Message handlers for Trim/Archive/Clear:** These send messages to the extension host, which then:
- `trim`: opens QuickPick `["7 days", "14 days", "30 days", "90 days"]`, maps to ms, calls `gitHelper.trimAuditLog(ms)`, shows count, refreshes panel
- `archiveAndTrim`: same date picker, calls `vscode.window.showSaveDialog`, writes filtered JSON to file, then calls `trimAuditLog`
- `clearAll`: shows modal with "Type CLEAR to confirm" input, calls `gitHelper.trimAuditLog(0)` (trim everything — 0 cutoff means keep nothing)
- `export`: opens QuickPick `["JSON", "CSV"]`, opens save dialog, writes the currently-filtered entries

**Size guard:** At panel open time, call `gitHelper.getAuditLogSizeBytes()`. If > 5MB, prepend a banner to the HTML:
```typescript
const sizeBytes = await gitHelper.getAuditLogSizeBytes();
const sizeBanner = sizeBytes > 5 * 1024 * 1024
    ? `<div class="warning">⚠ Audit log is large (${(sizeBytes / 1024 / 1024).toFixed(1)} MB) — consider trimming or archiving old entries.</div>`
    : "";
```

The full rewrite of `AuditTrailPanel.ts` follows the same class pattern as `DeploymentDashboardPanel` (static `createOrShow`, `WebviewPanel`, `onDidReceiveMessage`). Read the existing `AuditTrailPanel.ts` carefully before modifying to preserve the existing entry-rendering logic — add the new features on top rather than replacing the rendering.

- [ ] **Step 6: Compile**

```bash
npm run compile
```

- [ ] **Step 7: Manual verification**

Launch Extension Development Host. Open Audit Trail. Verify filter controls appear. Filter by "Deploy" — only deploy entries shown. Click Export → JSON — confirm a file is saved. As Admin, click Trim → "Last 7 days" — confirm count shown and log updates. Verify "Clear All" requires typing "CLEAR".

- [ ] **Step 8: Commit**

```bash
git add src/providers/AuditTrailPanel.ts src/GitHelper.ts src/config.ts src/extension.ts package.json
git commit -m "feat: audit trail management — filters, scoped export, trim/archive/clear, auto-trim, size guard"
```

---

### Task 5: Admin Panel — Full-Tab Three-Tab View

**Files:**
- Create: `src/providers/AdminPanel.ts`
- Modify: `src/providers/StoryWebviewProvider.ts` (⚙ Setup button opens AdminPanel)
- Modify: `src/extension.ts` (register `sfDevops.openAdminPanel`)
- Modify: `package.json` (add command)

**Interfaces:**
- Consumes: `runSetupChecks` (with role param from Plan 1 Task 4), `getOrgAliasSlots`, `setOrgAliasSlot`, `getEnvironments`, `canAccessConfig`, `getEffectiveRole`, `hasRolePassword`, `resetRolePassword`, `resetRolePasswordForce` (from Plan 1 Task 3)
- Produces: `AdminPanel.createOrShow(gitHelper, bbClient, context)`

- [ ] **Step 1: Create `src/providers/AdminPanel.ts`**

```typescript
// AdminPanel.ts — Full-tab Admin panel with three tabs:
// 1. Setup Check — same checks as the sidebar gate, with inline org-alias management
// 2. Environments — Admin-editable pipeline configuration
// 3. Role & Security — Admin-only: password management, role-change audit
//
// Lead/Developer see Tab 1 (read-only org aliases) and Tab 2 (read-only pipeline diagram).
// Tab 3 is hidden for non-Admin roles.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper } from "../GitHelper";
import { runSetupChecks, SetupCheckItem } from "../SetupCheck";
import {
    getEffectiveRole, canAccessConfig, hasRolePassword,
    resetRolePassword, resetRolePasswordForce,
} from "../RoleManager";
import {
    getOrgAliasSlots, setOrgAliasSlot, OrgAliasSlot, getEnvironments,
    getRoles, ResolvedEnvironment,
} from "../config";
import { isOrgConnected, execSf } from "../SfCli";

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}

type AdminTab = "setup" | "environments" | "security";

export class AdminPanel {
    private static current: AdminPanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];
    private _activeTab: AdminTab = "setup";

    private constructor(
        private readonly _gitHelper: GitHelper,
        private readonly _bbClient:  IGitProviderClient,
        private readonly _context:   vscode.ExtensionContext
    ) {
        this._panel = vscode.window.createWebviewPanel(
            "sfDevopsAdmin",
            "SF DevOps Admin",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this._panel.webview.html = this._loadingHtml();
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg: { command: string; key?: string; value?: string; tab?: AdminTab }) => {
            switch (msg.command) {
                case "switchTab":
                    if (msg.tab) { this._activeTab = msg.tab; await this.refresh(); }
                    break;
                case "recheckSetup":
                    await this.refresh(); break;
                case "confirmSetup":
                    await this._context.workspaceState.update("sfDevops.setupConfirmed", true);
                    await this.refresh(); break;
                case "saveOrgAlias":
                    if (msg.key && canAccessConfig(getEffectiveRole(this._context))) {
                        await setOrgAliasSlot(msg.key as OrgAliasSlot["key"], (msg.value ?? "").trim());
                        await this.refresh();
                    }
                    break;
                case "loginOrg":
                    if (msg.key && msg.value?.trim() && canAccessConfig(getEffectiveRole(this._context))) {
                        const alias = msg.value.trim();
                        await setOrgAliasSlot(msg.key as OrgAliasSlot["key"], alias);
                        const connected = await isOrgConnected(alias, this._gitHelper.getWorkspaceRoot());
                        if (connected) {
                            vscode.window.showInformationMessage(`"${alias}" is already authenticated.`);
                        } else {
                            const terminal = vscode.window.createTerminal(`sf org login: ${alias}`);
                            terminal.show();
                            terminal.sendText(`sf org login web --alias ${alias}`);
                        }
                        await this.refresh();
                    }
                    break;
                case "openOrg":
                    if (msg.value?.trim()) {
                        await execSf(["org", "open", "--target-org", msg.value.trim()], {
                            cwd: this._gitHelper.getWorkspaceRoot(), timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
                        }).catch(err => vscode.window.showErrorMessage(`Could not open org: ${err?.message ?? err}`));
                    }
                    break;
                case "resetPassword":
                    await resetRolePassword(this._context, this._gitHelper);
                    await this.refresh(); break;
                case "resetPasswordForce":
                    await resetRolePasswordForce(this._context, this._gitHelper);
                    await this.refresh(); break;
                case "saveEnvironments":
                    if (msg.value && canAccessConfig(getEffectiveRole(this._context))) {
                        try {
                            const parsed = JSON.parse(msg.value);
                            await vscode.workspace.getConfiguration("sfDevops")
                                .update("environments", parsed, vscode.ConfigurationTarget.Workspace);
                            vscode.window.showInformationMessage("Environments saved.");
                        } catch {
                            vscode.window.showErrorMessage("Invalid environment configuration — check JSON syntax.");
                        }
                        await this.refresh();
                    }
                    break;
            }
        }, null, this._disposables);
        this.refresh();
    }

    static createOrShow(gitHelper: GitHelper, bbClient: IGitProviderClient, context: vscode.ExtensionContext): void {
        if (AdminPanel.current) {
            AdminPanel.current._panel.reveal();
            return;
        }
        AdminPanel.current = new AdminPanel(gitHelper, bbClient, context);
    }

    async refresh(): Promise<void> {
        this._panel.webview.html = this._loadingHtml();
        try {
            const role   = getEffectiveRole(this._context);
            const isAdmin = canAccessConfig(role);
            const checks = await runSetupChecks(this._gitHelper, this._bbClient, this._context, role);
            const slots  = getOrgAliasSlots();
            const envs   = getEnvironments();
            const connectedAliases = checks.find(c => c.key === "orgAuthentication")?.connectedAliases ?? {};
            const leadPwSet  = await hasRolePassword(this._context, "Lead");
            const adminPwSet = await hasRolePassword(this._context, "Admin");
            this._panel.webview.html = this._renderHtml(role, isAdmin, checks, slots, envs, connectedAliases, leadPwSet, adminPwSet);
        } catch (err) {
            this._panel.webview.html = `<html><body style="padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-errorForeground)">Error: ${escapeHtml(String(err))}</body></html>`;
        }
    }

    private _renderHtml(
        role: string, isAdmin: boolean, checks: SetupCheckItem[],
        slots: OrgAliasSlot[], envs: ResolvedEnvironment[],
        connectedAliases: Record<string, boolean>,
        leadPwSet: boolean, adminPwSet: boolean
    ): string {
        const tab = this._activeTab;
        const tabBtn = (id: AdminTab, label: string) =>
            `<button class="tab-btn ${tab === id ? "active" : ""}" onclick="send('switchTab','${id}')">${label}</button>`;

        const tabs = `<div class="tab-bar">
  ${tabBtn("setup", "⚙ Setup Check")}
  ${tabBtn("environments", "🌐 Environments")}
  ${isAdmin ? tabBtn("security", "🔐 Role & Security") : ""}
</div>`;

        let content = "";
        if (tab === "setup")        { content = this._setupTab(checks, slots, isAdmin, connectedAliases); }
        else if (tab === "environments") { content = this._environmentsTab(envs, isAdmin, role); }
        else if (tab === "security" && isAdmin) { content = this._securityTab(leadPwSet, adminPwSet); }

        return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 0; color: var(--vscode-foreground); display: flex; flex-direction: column; height: 100vh; }
  .tab-bar { display: flex; gap: 0; border-bottom: 2px solid var(--vscode-panel-border); padding: 0 12px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); flex-shrink: 0; }
  .tab-btn { padding: 8px 16px; border: none; border-bottom: 2px solid transparent; margin-bottom: -2px; background: transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 12px; }
  .tab-btn.active { border-bottom-color: var(--vscode-button-background); color: var(--vscode-button-background); font-weight: 600; }
  .tab-btn:hover { background: var(--vscode-list-hoverBackground); }
  .tab-content { flex: 1; overflow-y: auto; padding: 16px; }
  .check { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 12px; margin-bottom: 8px; }
  .check.fail { border-color: var(--vscode-inputValidation-errorBorder); }
  .check.warn { border-color: var(--vscode-inputValidation-warningBorder); }
  .check-head { display: flex; align-items: center; gap: 6px; font-weight: 600; margin-bottom: 3px; }
  .check .detail { font-size: 11px; color: var(--vscode-descriptionForeground); margin-left: 22px; }
  .check ol.fix { margin: 6px 0 0 22px; padding-left: 16px; font-size: 11px; color: var(--vscode-editorWarning-foreground); }
  .org-manager { margin: 8px 0 0 22px; }
  .org-row { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
  .org-label { font-size: 11px; width: 36px; flex-shrink: 0; color: var(--vscode-descriptionForeground); }
  .org-row input { flex: 1; font-size: 11px; padding: 3px 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
  .org-btn { font-size: 11px; padding: 3px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  .org-readonly { flex: 1; font-size: 11px; }
  .btn { padding: 6px 12px; border: none; border-radius: 4px; cursor: pointer; font-size: 12px; }
  .btn-primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn-secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn-danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-errorForeground); border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .warning { background: var(--vscode-inputValidation-warningBackground); border: 1px solid var(--vscode-inputValidation-warningBorder); border-radius: 4px; padding: 8px 10px; font-size: 11px; margin-bottom: 10px; }
  .info { background: var(--vscode-textBlockQuote-background); border: 1px solid var(--vscode-textBlockQuote-border); border-radius: 4px; padding: 8px 10px; font-size: 11px; margin-bottom: 10px; }
  /* Pipeline preview */
  .pipeline-preview { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
  .env-dot { display: flex; flex-direction: column; align-items: center; gap: 3px; }
  .env-dot .dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
  .env-dot .dot-label { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .env-arrow { color: var(--vscode-descriptionForeground); font-size: 14px; margin-top: -10px; }
  .env-card { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; }
  .env-card-header { font-weight: 600; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .env-badge { font-size: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 3px; padding: 1px 5px; color: var(--vscode-descriptionForeground); }
  /* Security tab */
  .pw-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .pw-label { font-weight: 600; }
  .pw-status { font-size: 11px; }
  .pw-status.set { color: var(--vscode-charts-green); }
  .pw-status.unset { color: var(--vscode-descriptionForeground); }
  .section-title { font-weight: 600; font-size: 13px; margin: 16px 0 8px; }
  .action-footer { position: sticky; bottom: 0; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-top: 1px solid var(--vscode-panel-border); padding: 10px 16px; display: flex; gap: 8px; }
</style>
</head>
<body>
${tabs}
<div class="tab-content">
${content}
</div>
<script>
  const vscode = acquireVsCodeApi();
  function send(cmd, key, value) {
    vscode.postMessage({ command: cmd, key: key, value: value,
      tab: (cmd === 'switchTab' ? key : undefined) });
  }
  function saveOrgAlias(key) { const el = document.getElementById('alias-' + key); send('saveOrgAlias', key, el ? el.value : ''); }
  function loginOrg(key) { const el = document.getElementById('alias-' + key); send('loginOrg', key, el ? el.value : ''); }
  function openOrg(alias) { if (alias) { send('openOrg', null, alias); } }
  function openOrgFromInput(key) { const el = document.getElementById('alias-' + key); openOrg(el ? el.value : ''); }
  function saveEnvironments() {
    const ta = document.getElementById('envJson');
    if (ta) { send('saveEnvironments', null, ta.value); }
  }
</script>
</body>
</html>`;
    }

    private _setupTab(checks: SetupCheckItem[], slots: OrgAliasSlot[], isAdmin: boolean, connectedAliases: Record<string, boolean>): string {
        const required = checks.filter(c => c.required);
        const optional = checks.filter(c => !c.required);
        const allRequiredPass = required.every(c => c.passed);

        const banner = allRequiredPass
            ? `<div class="info">✅ All required checks pass.</div>`
            : `<div class="warning">⚠ ${required.filter(c => !c.passed).length} required check(s) failing — fix them below, then re-check.</div>`;

        const renderCheck = (c: SetupCheckItem): string => {
            const icon = c.passed ? "✅" : (c.required ? "❌" : "⚠️");
            const optTag = !c.required ? `<span style="font-size:10px;font-weight:normal;color:var(--vscode-descriptionForeground);margin-left:4px">optional</span>` : "";
            const fixHtml = (!c.passed && c.fixSteps.length)
                ? `<ol class="fix">${c.fixSteps.map(s => `<li>${escapeHtml(s)}</li>`).join("")}</ol>`
                : "";
            const orgMgr = c.key === "orgAuthentication"
                ? this._orgAliasRows(slots, isAdmin, connectedAliases)
                : "";
            return `<div class="check ${c.passed ? "pass" : (c.required ? "fail" : "warn")}">
  <div class="check-head"><span>${icon}</span><span>${escapeHtml(c.label)}</span>${optTag}</div>
  <div class="detail">${escapeHtml(c.detail)}</div>
  ${fixHtml}${orgMgr}
</div>`;
        };

        const reqRows = required.map(renderCheck).join("");
        const optRows = optional.length
            ? `<details style="margin-top:12px"><summary style="cursor:pointer;font-size:11px;color:var(--vscode-textLink-foreground)">Optional checks (${optional.length})</summary>${optional.map(renderCheck).join("")}</details>`
            : "";

        return `${banner}${reqRows}${optRows}
<div class="action-footer">
  <button class="btn btn-primary" onclick="send('recheckSetup')">🔄 Re-check</button>
  ${allRequiredPass ? `<button class="btn btn-secondary" onclick="send('confirmSetup')">✅ Confirm</button>` : ""}
</div>`;
    }

    private _orgAliasRows(slots: OrgAliasSlot[], isAdmin: boolean, connectedAliases: Record<string, boolean>): string {
        const statusGlyph = (s: OrgAliasSlot) => {
            if (!s.alias) { return `<span title="No alias set">—</span>`; }
            return connectedAliases[s.key] ? `<span title="Connected">✅</span>` : `<span title="Not authenticated">❌</span>`;
        };
        const rows = isAdmin
            ? slots.map(s => `<div class="org-row">
  ${statusGlyph(s)}<span class="org-label">${escapeHtml(s.label)}</span>
  <input type="text" id="alias-${s.key}" value="${escapeHtml(s.alias)}" placeholder="org alias">
  <button class="org-btn" onclick="saveOrgAlias('${s.key}')">💾</button>
  <button class="org-btn" onclick="loginOrg('${s.key}')">🔑</button>
  <button class="org-btn" onclick="openOrgFromInput('${s.key}')">🌐</button>
</div>`).join("")
            : slots.map(s => `<div class="org-row">
  ${statusGlyph(s)}<span class="org-label">${escapeHtml(s.label)}</span>
  <span class="org-readonly">${escapeHtml(s.alias) || "(not set)"}</span>
  ${s.alias ? `<button class="org-btn" onclick="openOrg('${escapeHtml(s.alias)}')">🌐</button>` : ""}
</div>`).join("");

        const note = isAdmin ? "" : `<div style="font-size:10px;color:var(--vscode-descriptionForeground);margin-top:4px">Ask an Admin to configure org aliases.</div>`;
        return `<div class="org-manager">${rows}${note}</div>`;
    }

    private _environmentsTab(envs: ResolvedEnvironment[], isAdmin: boolean, _role: string): string {
        // Pipeline preview — always visible
        const dots = envs.map((e, i) => `<div class="env-dot">
  <div class="dot" title="${escapeHtml(e.label)}${e.requiredRole ? ` (${e.requiredRole})` : ""}"></div>
  <div class="dot-label">${escapeHtml(e.label)}</div>
</div>${i < envs.length - 1 ? `<div class="env-arrow">→</div>` : ""}`).join("");
        const preview = `<div class="pipeline-preview">${dots}</div>`;

        if (!isAdmin) {
            const envCards = envs.map(e => `<div class="env-card">
  <div class="env-card-header">${escapeHtml(e.label)}
    ${e.requiredRole ? `<span class="env-badge">Requires ${escapeHtml(e.requiredRole)}</span>` : ""}
    ${e.coverageGate ? `<span class="env-badge">Coverage gate</span>` : ""}
    ${e.signoffGate ? `<span class="env-badge">Sign-off gate</span>` : ""}
    ${e.locked ? `<span class="env-badge" style="color:var(--vscode-errorForeground)">🔴 Locked</span>` : ""}
    ${e.isProd ? `<span class="env-badge" style="color:var(--vscode-errorForeground)">Production</span>` : ""}
  </div>
  <div style="font-size:11px;color:var(--vscode-descriptionForeground)">Branch: ${escapeHtml(e.branch)}</div>
</div>`).join("");
            return `<div class="section-title">Pipeline</div>${preview}${envCards}<div class="info" style="margin-top:12px">Contact an Admin to modify pipeline configuration.</div>`;
        }

        // Admin: show JSON editor (simple but functional — avoids building a full form UI)
        const currentJson = JSON.stringify(
            envs.map(e => ({
                name: e.name, label: e.label !== e.name.toUpperCase() ? e.label : undefined,
                branch: e.branch !== e.name ? e.branch : undefined,
                requiredRole: e.requiredRole, coverageGate: e.coverageGate || undefined,
                signoffGate: e.signoffGate || undefined, isProd: e.isProd || undefined,
                locked: e.locked || undefined, deployTestLevel: e.deployTestLevel !== "RunLocalTests" ? e.deployTestLevel : undefined,
            }).reduce((acc: any, _) => { /* strip undefined */ return Object.fromEntries(Object.entries(acc).filter(([,v]) => v !== undefined)); }, e)),
            null, 2
        );
        return `<div class="section-title">Pipeline</div>${preview}
<div class="info">Edit the environment pipeline below. Changes save immediately to workspace settings.json.</div>
<textarea id="envJson" style="width:100%;height:340px;font-family:monospace;font-size:11px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);border-radius:4px;padding:8px;box-sizing:border-box;resize:vertical">${escapeHtml(currentJson)}</textarea>
<div class="action-footer">
  <button class="btn btn-primary" onclick="saveEnvironments()">💾 Save Environments</button>
</div>`;
    }

    private _securityTab(leadPwSet: boolean, adminPwSet: boolean): string {
        const pwRow = (role: string, isSet: boolean) => `<div class="pw-row">
  <span class="pw-label">${escapeHtml(role)} role password</span>
  <span class="pw-status ${isSet ? "set" : "unset"}">${isSet ? "✅ Set" : "❌ Not set"}</span>
</div>`;
        return `<div class="section-title">Role Passwords</div>
${pwRow("Lead", leadPwSet)}
${pwRow("Admin", adminPwSet)}
<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">
  <button class="btn btn-secondary" onclick="send('resetPassword')">🔑 Change a role password</button>
  <button class="btn btn-danger" onclick="send('resetPasswordForce')">⚠ Reset all passwords (break-glass)</button>
</div>
<div class="info" style="margin-top:16px">Role passwords are stored in VS Code's encrypted secrets store — never in settings.json or source code.</div>`;
    }

    private _loadingHtml(): string {
        return `<html><body style="padding:16px;font-family:var(--vscode-font-family)">Loading…</body></html>`;
    }

    private _dispose(): void {
        AdminPanel.current = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}
```

- [ ] **Step 2: Register `sfDevops.openAdminPanel` in extension.ts**

Add import:
```typescript
import { AdminPanel } from "./providers/AdminPanel";
```

Add command inside `context.subscriptions.push(...)`:
```typescript
vscode.commands.registerCommand("sfDevops.openAdminPanel", () => {
    AdminPanel.createOrShow(gitHelper, bbClient, context);
}),
```

- [ ] **Step 3: Reroute ⚙ Setup button in StoryWebviewProvider to open AdminPanel**

In `src/providers/StoryWebviewProvider.ts`, in `onDidReceiveMessage`, find:
```typescript
case "openSetupCheck":
    this._forceShowSetup = true;
    this.refresh();
    break;
```

Change to:
```typescript
case "openSetupCheck":
    vscode.commands.executeCommand("sfDevops.openAdminPanel"); break;
```

The `_forceShowSetup` path in `refresh()` can be kept as a fallback (the AdminPanel opens as a full tab; the sidebar's setup gate logic is still used on startup). Remove the `closeSetupCheck` and `recheckSetup`/`confirmSetup` cases from `onDidReceiveMessage` only if the corresponding buttons no longer appear in any webview — leave them if the sidebar gate HTML still uses them.

- [ ] **Step 4: Add command to package.json**

```json
{
    "command": "sfDevops.openAdminPanel",
    "title": "Open Admin Panel",
    "icon": "$(shield)",
    "category": "Salesforce DevOps"
}
```

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: zero errors. The `AdminPanel` constructor builds significant HTML — most type errors will be in `_renderHtml` or `_environmentsTab`. Fix any TypeScript complaints (usually missing `?.` or incorrect property names). Double-check that `hasRolePassword` now takes two params (from Plan 1 Task 1) — all calls in `AdminPanel` already pass the role string.

- [ ] **Step 6: Manual verification**

Launch Extension Development Host. Click ⚙ Setup in the Current Story panel toolbar. Verify the Admin Panel opens as a full editor tab. Switch between tabs:
- Setup Check tab: shows all env checks, org alias rows
- Environments tab (Admin): shows JSON editor with current environments; edit and Save — verify settings.json updates
- Environments tab (Developer/Lead): read-only pipeline diagram with no edit controls
- Role & Security tab (Admin only): shows Lead/Admin password status; "Change a role password" triggers the password reset flow

- [ ] **Step 7: Final Plan 3 smoke test**

With all of Plan 3 complete, verify the full flow:
1. Stale story banner appears and can be dismissed
2. Lead role sees ⚡ Actions link, clicks it — QuickPick lists stories pending action
3. Set an environment to `"locked": true` in Admin Panel → Environments tab — verify Promote button disappears and tree shows lock icon
4. Audit Trail filter controls work, Export saves a file, Trim removes old entries
5. Admin Panel's three tabs all render correctly per role

- [ ] **Step 8: Commit**

```bash
git add src/providers/AdminPanel.ts src/extension.ts src/providers/StoryWebviewProvider.ts package.json
git commit -m "feat: full-tab Admin panel with Setup Check, Environments, and Role & Security tabs"
```
