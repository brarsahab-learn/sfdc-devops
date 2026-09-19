# SF DevOps — Plan 2: Functional Gaps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the five functional capabilities that turn the extension from a "mostly works" tool into a robust CI/CD platform: PR auto-description, better conflict resolution, role-filtered notifications with backoff, rollback, and a multi-story pipeline panel.

**Architecture:** Mostly modifications to existing files. One new file: `StoryPipelinePanel.ts`. Plan 1 must be complete before starting this plan (role-aware logic is a dependency for the Pipeline Panel and notifications).

**Tech Stack:** TypeScript, VS Code Extension API, HTML/CSS in webview strings

**Spec:** `docs/superpowers/specs/2026-09-04-sf-devops-prelaunch-hardening-design.md` §3

## Global Constraints

- `npm run compile` must pass with zero errors after every task
- No new npm dependencies
- `escapeHtml()` must wrap every user-supplied string interpolated into webview HTML
- Compile command: `npm run compile`
- Manual test: F5 launches Extension Development Host

---

### Task 1: PR Description Auto-Generation

**Files:**
- Modify: `src/GitProviderClient.ts` (add optional `body` to `buildPrUrl`)
- Modify: `src/BitbucketClient.ts` (append URL-encoded body)
- Modify: `src/GitHubClient.ts` (append URL-encoded body)
- Modify: `src/commands/promoteStory.ts` (generate body and pass to `buildPrUrl`)

**Interfaces:**
- Produces: `buildPrUrl(fromBranch, toBranch, repoOverride?, body?)` — `body` optional, both clients must handle `undefined` gracefully

- [ ] **Step 1: Add optional `body` to `IGitProviderClient.buildPrUrl`**

In `src/GitProviderClient.ts`, find the `IGitProviderClient` interface and update the `buildPrUrl` signature:

```typescript
buildPrUrl(
    fromBranch: string,
    toBranch: string,
    repoOverride?: { workspace: string; repoSlug: string },
    body?: string
): string | null;
```

- [ ] **Step 2: Update BitbucketClient.buildPrUrl to append body**

In `src/BitbucketClient.ts`, find `buildPrUrl`. At the end, before returning the URL, append the body if provided:

```typescript
buildPrUrl(fromBranch: string, toBranch: string, repoOverride?: { workspace: string; repoSlug: string }, body?: string): string | null {
    // ... existing URL construction ...
    
    // Append prefilled PR description if provided
    if (body) {
        const encoded = encodeURIComponent(body);
        // Bitbucket uses `description` query param on its PR create page
        url += (url.includes("?") ? "&" : "?") + `description=${encoded}`;
    }
    return url;
}
```

Adjust exactly where in the existing method to add this — it must come after the existing URL is fully built and before `return url`.

- [ ] **Step 3: Update GitHubClient.buildPrUrl to append body**

In `src/GitHubClient.ts`, find `buildPrUrl` and apply the same pattern — GitHub uses `body` as the query param:

```typescript
if (body) {
    const encoded = encodeURIComponent(body);
    url += (url.includes("?") ? "&" : "?") + `body=${encoded}`;
}
return url;
```

- [ ] **Step 4: Generate the PR body in `openPromotionPR`**

In `src/commands/promoteStory.ts`, find `openPromotionPR`. Just before the `buildPrUrl` call, add:

```typescript
// Auto-generate PR description from what the extension already knows
const ticketLink = buildTicketUrl(storyId);
const { xml: _xml, unmapped: _unmapped, typeGroups } = buildPackageXmlWithGroups(changedFiles);
const metadataLines = Object.entries(typeGroups)
    .map(([type, count]) => `- ${type}: ${count}`)
    .join("\n");

const prBody = [
    `## ${storyId}`,
    ticketLink ? `\n[View ticket](${ticketLink})` : "",
    `\n### Metadata changed`,
    metadataLines || "- (no metadata types detected)",
    `\n### Validation`,
    `✅ Validated against ${envUpper} — ${validatedResult?.numberComponentsDeployed ?? 0} component(s)`,
].filter(Boolean).join("\n");
```

Then pass `prBody` to `buildPrUrl`:
```typescript
const prUrl = bbClient.buildPrUrl(promotionBranch, targetBranch, repoOverride, prBody);
```

**Note:** `buildPackageXmlWithGroups` does not exist yet — see Step 5.

- [ ] **Step 5: Add `buildPackageXmlWithGroups` to AuditLog.ts**

In `src/AuditLog.ts`, add a new export alongside `buildPackageXml`:

```typescript
/**
 * Same as buildPackageXml but also returns a type→count map for PR description generation.
 */
export function buildPackageXmlWithGroups(
    files: AuditChangedFile[]
): { xml: string; unmapped: string[]; typeGroups: Record<string, number> } {
    const { xml, unmapped } = buildPackageXml(files);
    const typeGroups: Record<string, number> = {};
    for (const f of files) {
        const type = metadataTypeForPath(f.path);
        if (type) {
            typeGroups[type] = (typeGroups[type] ?? 0) + 1;
        }
    }
    return { xml, unmapped, typeGroups };
}
```

- [ ] **Step 6: Import `buildPackageXmlWithGroups` in promoteStory.ts**

In `src/commands/promoteStory.ts`, update the AuditLog import:

```typescript
import { buildPackageXml, buildPackageXmlWithGroups, AuditChangedFile } from "../AuditLog";
```

Also import `buildTicketUrl` from config if not already imported:
```typescript
import { ..., buildTicketUrl } from "../config";
```

Pass the `validatedResult` from `runPromotionValidate` through to `openPromotionPR`. Currently `finalizeAndFinish` calls `openPromotionPR` but `valResult` is in scope there. Store it:

```typescript
// In finalizeAndFinish, after recording validation:
await openPromotionPR(bbClient, gitHelper, storyId, targetEnv, storyProvider, progress, valResult);
```

Update `openPromotionPR` signature to accept optional `valResult`:

```typescript
export async function openPromotionPR(
    bbClient:      IGitProviderClient,
    gitHelper:     GitHelper,
    storyId:       string,
    targetEnv:     string,
    storyProvider: StoryWebviewProvider,
    progress?:     vscode.Progress<{ message?: string }>,
    valResult?:    DeployResult
): Promise<void>
```

- [ ] **Step 7: Compile**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 8: Manual verification**

Launch Extension Development Host. Promote a story to QA. When the browser opens the PR creation page, verify the description is pre-filled with the story ID, metadata types, and validation summary.

- [ ] **Step 9: Commit**

```bash
git add src/GitProviderClient.ts src/BitbucketClient.ts src/GitHubClient.ts src/commands/promoteStory.ts src/AuditLog.ts
git commit -m "feat: auto-generate PR description with metadata types and validation summary"
```

---

### Task 2: Conflict Resolution — Open All Conflicted Files

**Files:**
- Modify: `src/commands/promoteStory.ts` (`reportOperationConflict`)
- Modify: `src/providers/StoryWebviewProvider.ts` (`_getConflictHtml`)

**Interfaces:**
- No interface changes — both are internal rendering/UX changes

- [ ] **Step 1: Update `reportOperationConflict` to open all conflicted files**

In `src/commands/promoteStory.ts`, find `reportOperationConflict`. Replace the `if (choice === "Open Conflicts")` block:

```typescript
if (choice === "Open Conflicts") {
    // Open all conflicted files (up to 8), not just the first
    const toOpen = conflicts.slice(0, 8);
    for (const conflictedFile of toOpen) {
        const fileUri = vscode.Uri.joinPath(vscode.Uri.file(gitHelper.getWorkspaceRoot()), conflictedFile);
        await vscode.window.showTextDocument(fileUri, { preview: false }).then(undefined, () => {});
    }
    if (conflicts.length > 8) {
        vscode.window.showInformationMessage(`…and ${conflicts.length - 8} more conflict(s) — see the Source Control view for the full list.`);
    }
    await vscode.commands.executeCommand("workbench.view.scm");
}
```

- [ ] **Step 2: Make conflict file rows clickable in `_getConflictHtml`**

In `src/providers/StoryWebviewProvider.ts`, find `_getConflictHtml`. The `fileRows` section currently renders:

```typescript
const fileRows = conflicts.length
    ? conflicts.map(f => `<div class="file">⚠ ${f}</div>`).join("")
    : `<div class="ok">✓ No unresolved conflicts left — click Resume.</div>`;
```

Replace with clickable rows:

```typescript
const fileRows = conflicts.length
    ? conflicts.map(f =>
        `<div class="file">⚠ <a href="#" onclick="openConflict('${escapeHtml(f)}')" title="Open in editor">${escapeHtml(f)}</a></div>`
      ).join("")
    : `<div class="ok">✓ No unresolved conflicts left — click Resume.</div>`;
```

- [ ] **Step 3: Add `openConflict` JS function to the conflict panel script**

In `_getConflictHtml`, find the `<script>` block at the bottom. Add:

```typescript
function openConflict(path) {
    vscode.postMessage({ command: 'viewWorkingFileDiff', path: path });
}
```

- [ ] **Step 4: Compile**

```bash
npm run compile
```

- [ ] **Step 5: Manual verification**

Launch Extension Development Host. Trigger a cherry-pick conflict. In the conflict panel, verify file rows are now clickable links. Clicking a file opens it in the editor. The "Open Conflicts" action in the warning notification should open all (up to 8) conflicted files.

- [ ] **Step 6: Commit**

```bash
git add src/commands/promoteStory.ts src/providers/StoryWebviewProvider.ts
git commit -m "feat: conflict resolution opens all conflicted files, not just the first"
```

---

### Task 3: Role-Filtered Notifications & Network-Aware Polling

**Files:**
- Modify: `src/extension.ts`

**Interfaces:**
- No new exports — all changes internal to `extension.ts`

- [ ] **Step 1: Add exponential backoff state variables**

At the top of `extension.ts`, near the `let deployPoller` declaration, add:

```typescript
let _pollFailCount = 0;
let _pollIntervalMs = 60_000;
const POLL_MIN_MS   = 60_000;
const POLL_MAX_MS   = 600_000;
const POLL_FAIL_CAP = 3; // warn user after this many consecutive failures
```

- [ ] **Step 2: Convert the fixed `setInterval` to a self-rescheduling setTimeout**

In `activate()`, replace:

```typescript
deployPoller = setInterval(() => { checkPendingDeployments(gitHelper); }, 60_000);
context.subscriptions.push({
    dispose: () => { if (deployPoller) { clearInterval(deployPoller); } }
});
```

With:

```typescript
function schedulePoll() {
    deployPoller = setTimeout(async () => {
        await runPoll(gitHelper, context);
        schedulePoll();
    }, _pollIntervalMs);
}
schedulePoll();
context.subscriptions.push({
    dispose: () => { if (deployPoller) { clearTimeout(deployPoller); } }
});
```

- [ ] **Step 3: Extract `runPoll` function that replaces `checkPendingDeployments`**

Add `runPoll` as a module-level async function (below `activate`):

```typescript
async function runPoll(gitHelper: GitHelper, context: vscode.ExtensionContext): Promise<void> {
    try {
        await checkPendingDeployments(gitHelper, context);
        // Success — reset backoff
        _pollFailCount = 0;
        _pollIntervalMs = POLL_MIN_MS;
    } catch {
        _pollFailCount++;
        _pollIntervalMs = Math.min(_pollIntervalMs * 2, POLL_MAX_MS);
        if (_pollFailCount === POLL_FAIL_CAP) {
            vscode.window.showWarningMessage(
                `Salesforce DevOps: can't reach origin — working offline. Retrying in ${Math.round(_pollIntervalMs / 1000)}s.`
            );
        }
    }
}
```

- [ ] **Step 4: Update `checkPendingDeployments` to accept context and filter by role**

Change the signature from:
```typescript
async function checkPendingDeployments(gitHelper: GitHelper): Promise<void>
```
To:
```typescript
async function checkPendingDeployments(gitHelper: GitHelper, context: vscode.ExtensionContext): Promise<void>
```

Inside the loop `for (const env of getPromotableEnvironments())`, wrap the notification block with a role check:

```typescript
const currentRole = getEffectiveRole(context);
if (!canPromote(currentRole, env)) { continue; } // this user can't act on this env — skip notification
```

Add this check just before `const currentSha = await gitHelper.remoteHeadSha(env.branch);`.

- [ ] **Step 5: Enhance notification text with story names**

Inside `checkPendingDeployments`, after the `lastDeploy` / `currentSha` check determines there is a pending deployment, resolve the pending story IDs. Import `groupChangesByStory` from `DeploymentPlanner`:

```typescript
import { groupChangesByStory, resolveSelection, DeploySelection, StoryChangeGroup, CommitInfo, apexClassNamesIn, resolveEffectiveTestLevel, buildApexTestMap } from "./DeploymentPlanner";
```

Then before showing the notification:

```typescript
let storyNames = "";
try {
    const lastSha = lastDeploy?.sha ?? null;
    const groups = await groupChangesByStory(gitHelper, env.branch, lastSha, currentSha);
    const ids = groups.map(g => g.storyId).filter(Boolean).slice(0, 4).join(", ");
    storyNames = ids ? `${ids} ` : "";
} catch { /* skip — notification still shows */ }

const choice = await vscode.window.showInformationMessage(
    `📦 ${storyNames}merged into ${env.label} — pending deployment.`,
    "Open Dashboard"
);
```

- [ ] **Step 6: Compile**

```bash
npm run compile
```
Expected: zero errors. Fix any import conflicts with `groupChangesByStory` if `DeploymentDashboardPanel` already imports it differently.

- [ ] **Step 7: Manual verification**

Launch Extension Development Host. Disconnect from the internet and wait ~60s. After 3 poll failures, verify the "working offline" warning appears. Reconnect — verify it doesn't warn again. With network connected and role set to Developer, verify no "UAT pending deploy" notifications appear.

- [ ] **Step 8: Commit**

```bash
git add src/extension.ts
git commit -m "feat: role-filtered merge notifications and exponential backoff polling"
```

---

### Task 4: Rollback / Redeploy Known-Good SHA in DeploymentDashboard

**Files:**
- Modify: `src/providers/DeploymentDashboardPanel.ts`
- Modify: `src/GitHelper.ts` (add `createTempBranchAtSha`)

**Interfaces:**
- Produces: `GitHelper.createTempBranchAtSha(sha: string, branchName: string): Promise<void>` — checks out a temp branch at a specific SHA
- Produces: `GitHelper.deleteTempBranch(branchName: string): Promise<void>` — deletes a local-only temp branch

- [ ] **Step 1: Add `createTempBranchAtSha` and `deleteTempBranch` to GitHelper**

In `src/GitHelper.ts`, add two methods near the other branch-management methods:

```typescript
/** Creates a local-only branch at a specific commit SHA — used for rollback deploys. */
async createTempBranchAtSha(sha: string, branchName: string): Promise<void> {
    await this.git(["checkout", "-B", branchName, sha]);
}

/** Deletes a local-only branch. Used to clean up rollback temp branches. */
async deleteTempBranch(branchName: string): Promise<void> {
    await this.git(["branch", "-D", branchName]);
}
```

`this.git(args)` is the pattern used throughout `GitHelper` for running git commands — adjust to match the exact method name used in the existing file (look for how `gitHelper.checkoutBranch` is implemented to confirm the internal git invocation pattern).

- [ ] **Step 2: Add rollback button to the DeploymentDashboard environment header**

In `src/providers/DeploymentDashboardPanel.ts`, find where the environment header HTML is rendered (look for where `lastDeploy` and `env.label` are used to build the header section). After the last-deployed SHA display, add a rollback link:

```typescript
const rollbackBtn = (lastDeploy && currentSha && lastDeploy.sha !== currentSha && canDeploy)
    ? `<a href="#" class="rollback-link" onclick="send('rollback')" title="Redeploy ${lastDeploy.sha.slice(0,8)} (deployed ${new Date(lastDeploy.deployedAt).toLocaleDateString()}, ${vm.lastDeploy?.numberComponentsDeployed ?? '?'} components)">⏪ Redeploy last known-good</a>`
    : "";
```

Add `${rollbackBtn}` to the header HTML near the SHA display.

Add CSS for `.rollback-link` in the panel's style block:
```css
.rollback-link { font-size: 11px; color: var(--vscode-textLink-foreground); text-decoration: none; margin-left: 8px; }
.rollback-link:hover { text-decoration: underline; }
```

- [ ] **Step 3: Handle `rollback` message in `onDidReceiveMessage`**

In the webview message handler inside `DeploymentDashboardPanel`, add a case for `'rollback'`:

```typescript
case 'rollback':
    await this._handleRollback();
    break;
```

- [ ] **Step 4: Implement `_handleRollback` method**

Add to `DeploymentDashboardPanel`:

```typescript
private async _handleRollback(): Promise<void> {
    const vm = this._lastViewModel;
    if (!vm?.lastDeploy || !vm.env.orgAlias) { return; }

    const { sha, deployedAt, numberComponentsDeployed } = vm.lastDeploy;
    const shortSha = sha.slice(0, 8);
    const deployedAtStr = new Date(deployedAt).toLocaleString();

    const confirm = await vscode.window.showWarningMessage(
        `Redeploy ${vm.env.label} to commit ${shortSha} (${deployedAtStr}, ${numberComponentsDeployed ?? "?"} components)?\n\nThis checks out that commit and runs a full deploy against ${vm.env.orgAlias}.`,
        { modal: true },
        "Yes, rollback"
    );
    if (!confirm) { return; }

    if (await this._gitHelper.hasUncommittedChanges()) {
        vscode.window.showWarningMessage("Commit or stash your local changes before running a rollback deploy.");
        return;
    }

    const originalBranch = await this._gitHelper.currentBranch();
    const tempBranch = `sf-devops-rollback-${vm.env.name}`;

    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Rolling back ${vm.env.label} to ${shortSha}...`, cancellable: false },
        async (progress) => {
            try {
                progress.report({ message: "Checking out rollback commit..." });
                await this._gitHelper.createTempBranchAtSha(sha, tempBranch);

                progress.report({ message: `Deploying to ${vm.env.orgAlias}...` });
                const result = await runDeploy(
                    this._gitHelper.getWorkspaceRoot(),
                    getSourceRootFolder(),
                    [],  // empty = full source root
                    vm.env.orgAlias!,
                    vm.env.deployTestLevel,
                    getDeployTimeoutSeconds(),
                    "deploy",
                    undefined,
                    (status) => progress.report({ message: status })
                );

                // Return to original branch regardless
                if (originalBranch) {
                    await this._gitHelper.checkoutBranch(originalBranch).catch(() => {});
                }
                await this._gitHelper.deleteTempBranch(tempBranch).catch(() => {});

                if (result.success) {
                    vscode.window.showInformationMessage(`✅ Rollback complete — ${vm.env.label} is back at ${shortSha}.`);
                    this.refresh();
                } else {
                    vscode.window.showErrorMessage(`❌ Rollback deploy failed: ${result.error ?? "see output channel"}. Temp branch ${tempBranch} left for investigation.`);
                }
            } catch (err) {
                if (originalBranch) {
                    await this._gitHelper.checkoutBranch(originalBranch).catch(() => {});
                }
                vscode.window.showErrorMessage(`Rollback failed: ${err}`);
            }
        }
    );
}
```

Add `private _lastViewModel: EnvViewModel | undefined;` as a class field, and set `this._lastViewModel = vm;` at the end of the `refresh()` method (after the view model is built, before rendering HTML).

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: zero errors. Fix any missing imports (`runDeploy`, `getSourceRootFolder`, `getDeployTimeoutSeconds` are already imported in `DeploymentDashboardPanel`).

- [ ] **Step 6: Manual verification**

Launch Extension Development Host. Open the Deployment Dashboard for an env that has a prior deploy with a different current SHA. Verify the "⏪ Redeploy last known-good" link appears. Click it — verify the confirmation modal shows the SHA, date, and component count.

- [ ] **Step 7: Commit**

```bash
git add src/providers/DeploymentDashboardPanel.ts src/GitHelper.ts
git commit -m "feat: rollback/redeploy known-good SHA from Deployment Dashboard"
```

---

### Task 5: Multi-Story Pipeline Panel

**Files:**
- Create: `src/providers/StoryPipelinePanel.ts`
- Modify: `src/GitHelper.ts` (add `listRemoteFeatureBranches`, `branchLastCommitTimestamp`)
- Modify: `src/extension.ts` (register `sfDevops.openPipelineView`)
- Modify: `src/providers/StoryWebviewProvider.ts` (add Pipeline link to "more actions" footer)
- Modify: `package.json` (add command)

**Interfaces:**
- Consumes: `getStoryProgress` from `StoryProgress.ts`, `getEnvironments`, `extractStoryId`, `buildTicketUrl`, `canPromote`, `getEffectiveRole` — all already exported
- Produces: `StoryPipelinePanel.createOrShow(gitHelper, bbClient, context)`

- [ ] **Step 1: Add `listRemoteFeatureBranches` and `branchLastCommitTimestamp` to GitHelper**

In `src/GitHelper.ts`, add:

```typescript
/**
 * Lists feature branches on origin that are not already tracked locally.
 * Uses the configured featureBranchTemplate prefix. Capped at 50 results.
 */
async listRemoteFeatureBranches(): Promise<string[]> {
    const prefix = getFeatureBranchPrefix();
    try {
        const output = await this.git(["ls-remote", "--heads", "origin"]);
        const lines = output.trim().split("\n").filter(Boolean);
        const remoteBranches = lines
            .map(line => line.split("\t")[1]?.replace("refs/heads/", ""))
            .filter((b): b is string => Boolean(b) && b.startsWith(prefix));
        return remoteBranches.slice(0, 50);
    } catch {
        return [];
    }
}

/** Returns the Unix timestamp (seconds) of the last commit on a branch, or 0 on error. */
async branchLastCommitTimestamp(branch: string): Promise<number> {
    try {
        const out = await this.git(["log", "--max-count=1", "--format=%ct", branch]);
        return parseInt(out.trim(), 10) || 0;
    } catch {
        return 0;
    }
}
```

Add `import { getFeatureBranchPrefix } from "./config";` to GitHelper's imports if not already present.

- [ ] **Step 2: Create `src/providers/StoryPipelinePanel.ts`**

```typescript
// StoryPipelinePanel.ts — Multi-story pipeline view with Swimlane and Kanban layouts.
// Shows all active feature branches and their current state across every configured environment.

import * as vscode from "vscode";
import { IGitProviderClient } from "../GitProviderClient";
import { GitHelper } from "../GitHelper";
import { getEnvironments, getEffectiveRole, buildTicketUrl, canPromote, extractStoryId, ResolvedEnvironment } from "../config";
import { getStoryProgress } from "../StoryProgress";

const VIEW_STATE_KEY = "sfDevops.pipelineView";

function escapeHtml(s: string): string {
    return String(s).replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]!));
}

interface StoryRow {
    storyId: string;
    branch:  string;
    ageDays: number;
    progress: Record<string, string>;
    isStale: boolean;
}

const STATE_LABELS: Record<string, string> = {
    published:       "🟢 Published",
    deployed:        "🟢 Deployed",
    open:            "🔄 PR Open",
    merged:          "⚡ Merged",
    "branch-created":"🧪 Validating",
    none:            "○ None",
};

function stateLabel(state: string | undefined): string {
    return STATE_LABELS[state ?? "none"] ?? "○ None";
}

function stateClass(state: string | undefined): string {
    if (state === "deployed" || state === "published") { return "done"; }
    if (state === "open" || state === "merged")        { return "active"; }
    if (state === "branch-created")                    { return "active"; }
    return "none";
}

export class StoryPipelinePanel {
    private static current: StoryPipelinePanel | undefined;
    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    private constructor(
        private readonly _gitHelper: GitHelper,
        private readonly _bbClient:  IGitProviderClient,
        private readonly _context:   vscode.ExtensionContext
    ) {
        this._panel = vscode.window.createWebviewPanel(
            "sfDevopsPipeline",
            "SF DevOps Pipeline",
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this._panel.webview.html = this._loadingHtml();
        this._panel.onDidDispose(() => this._dispose(), null, this._disposables);
        this._panel.webview.onDidReceiveMessage(async (msg: { command: string }) => {
            switch (msg.command) {
                case "refresh":        await this.refresh(); break;
                case "switchSwimlane": this._saveView("swimlane"); await this.refresh(); break;
                case "switchKanban":   this._saveView("kanban");   await this.refresh(); break;
            }
        }, null, this._disposables);
        this.refresh();
    }

    static createOrShow(gitHelper: GitHelper, bbClient: IGitProviderClient, context: vscode.ExtensionContext): void {
        if (StoryPipelinePanel.current) {
            StoryPipelinePanel.current._panel.reveal();
            return;
        }
        StoryPipelinePanel.current = new StoryPipelinePanel(gitHelper, bbClient, context);
    }

    private _saveView(view: "swimlane" | "kanban"): void {
        this._context.workspaceState.update(VIEW_STATE_KEY, view);
    }

    private _currentView(): "swimlane" | "kanban" {
        return this._context.workspaceState.get<"swimlane" | "kanban">(VIEW_STATE_KEY, "swimlane");
    }

    async refresh(): Promise<void> {
        this._panel.webview.html = this._loadingHtml();
        try {
            const rows = await this._buildRows();
            const envs = getEnvironments();
            const view = this._currentView();
            const role = getEffectiveRole(this._context);
            this._panel.webview.html = this._renderHtml(rows, envs, view, role);
        } catch (err) {
            this._panel.webview.html = `<html><body style="padding:16px;font-family:var(--vscode-font-family);color:var(--vscode-errorForeground)">Error loading pipeline: ${escapeHtml(String(err))}</body></html>`;
        }
    }

    private async _buildRows(): Promise<StoryRow[]> {
        const localBranches  = await this._gitHelper.listFeatureBranches();
        const remoteBranches = await this._gitHelper.listRemoteFeatureBranches();
        const allBranches    = [...new Set([...localBranches, ...remoteBranches])];

        const staleThreshold = vscode.workspace.getConfiguration("sfDevops").get<number>("staleStoryThresholdDays", 14);

        const rows: StoryRow[] = await Promise.all(allBranches.map(async (branch) => {
            const storyId  = extractStoryId(branch) || branch;
            const progress = await getStoryProgress(this._gitHelper, this._bbClient, storyId).catch(() => ({}));
            const ts       = await this._gitHelper.branchLastCommitTimestamp(branch);
            const ageDays  = ts > 0 ? Math.floor((Date.now() / 1000 - ts) / 86400) : 0;
            return { storyId, branch, ageDays, progress, isStale: staleThreshold > 0 && ageDays >= staleThreshold };
        }));

        return rows.sort((a, b) => a.ageDays - b.ageDays);
    }

    private _renderHtml(rows: StoryRow[], envs: ResolvedEnvironment[], view: "swimlane" | "kanban", role: string): string {
        const isSwimlane = view === "swimlane";
        const content = isSwimlane ? this._swimlane(rows, envs, role) : this._kanban(rows, envs, role);
        const capNote = rows.length >= 50 ? `<div class="cap-note">Showing most recent 50 stories.</div>` : "";

        return `<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: var(--vscode-font-family); font-size: 12px; padding: 12px; color: var(--vscode-foreground); }
  .toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
  .tbtn { padding: 4px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; font-size: 11px; }
  .tbtn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tbtn:hover { background: var(--vscode-button-hoverBackground); color: var(--vscode-button-foreground); }
  .cap-note { font-size: 10px; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  /* Swimlane */
  table { border-collapse: collapse; width: 100%; font-size: 11px; }
  th { text-align: left; padding: 6px 8px; border-bottom: 2px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); white-space: nowrap; }
  td { padding: 5px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: middle; }
  .story-cell { font-weight: 600; white-space: nowrap; }
  .story-cell a { color: inherit; text-decoration: none; }
  .story-cell a:hover { text-decoration: underline; }
  .stale-badge { font-size: 10px; color: var(--vscode-editorWarning-foreground); margin-left: 4px; }
  .age { font-size: 10px; color: var(--vscode-descriptionForeground); }
  td.done { color: var(--vscode-charts-green); }
  td.active { color: var(--vscode-charts-blue); }
  td.none { color: var(--vscode-descriptionForeground); opacity: 0.6; }
  /* Kanban */
  .kanban { display: flex; gap: 10px; overflow-x: auto; }
  .col { min-width: 160px; flex: 1; background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 8px; }
  .col-header { font-weight: 600; font-size: 11px; margin-bottom: 8px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .card { background: var(--vscode-editor-widget-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 6px 8px; margin-bottom: 6px; font-size: 11px; }
  .card-id { font-weight: 600; }
  .card-id a { color: inherit; text-decoration: none; }
  .card-id a:hover { text-decoration: underline; }
  .card-age { font-size: 10px; color: var(--vscode-descriptionForeground); }
  .card-state { font-size: 10px; margin-top: 2px; }
  .empty-col { font-size: 10px; color: var(--vscode-descriptionForeground); opacity: 0.5; font-style: italic; }
</style>
</head>
<body>
<div class="toolbar">
  <button class="tbtn ${isSwimlane ? "active" : ""}" onclick="send('switchSwimlane')">☰ Swimlane</button>
  <button class="tbtn ${!isSwimlane ? "active" : ""}" onclick="send('switchKanban')">⊞ Board</button>
  <button class="tbtn" onclick="send('refresh')" style="margin-left:auto">↻ Refresh</button>
</div>
${capNote}
${content}
<script>
  const vscode = acquireVsCodeApi();
  function send(cmd) { vscode.postMessage({ command: cmd }); }
</script>
</body>
</html>`;
    }

    private _swimlane(rows: StoryRow[], envs: ResolvedEnvironment[], role: string): string {
        const headers = `<tr><th>Story</th><th>Age</th>${envs.map(e => `<th>${escapeHtml(e.label)}</th>`).join("")}</tr>`;
        const bodyRows = rows.map(row => {
            const ticketUrl = buildTicketUrl(row.storyId);
            const storyCell = ticketUrl
                ? `<a href="${escapeHtml(ticketUrl)}">${escapeHtml(row.storyId)}</a>`
                : escapeHtml(row.storyId);
            const staleTag = row.isStale ? `<span class="stale-badge">⏰ ${row.ageDays}d</span>` : "";
            const envCells = envs.map(env => {
                const state = row.progress[env.name];
                return `<td class="${stateClass(state)}">${stateLabel(state)}</td>`;
            }).join("");
            return `<tr>
  <td class="story-cell">${storyCell}${staleTag}</td>
  <td class="age">${row.ageDays}d</td>
  ${envCells}
</tr>`;
        }).join("");

        return `<table><thead>${headers}</thead><tbody>${bodyRows || '<tr><td colspan="100" style="text-align:center;opacity:0.5;padding:20px">No active stories found</td></tr>'}</tbody></table>`;
    }

    private _kanban(rows: StoryRow[], envs: ResolvedEnvironment[], _role: string): string {
        const columns = envs.map(env => {
            const cards = rows
                .filter(row => {
                    // Story belongs in this column if this is its current active stage
                    const state = row.progress[env.name];
                    if (state === "deployed" || state === "published") { return false; }
                    // Check no earlier unfinished env
                    const idx = envs.findIndex(e => e.name === env.name);
                    for (let i = 0; i < idx; i++) {
                        const prev = row.progress[envs[i].name];
                        if (prev !== "deployed" && prev !== "published") { return false; }
                    }
                    return true;
                });

            // Complete stories in last column
            const isLastEnv = envs[envs.length - 1].name === env.name;
            const completeCards = isLastEnv
                ? rows.filter(row => envs.every(e => row.progress[e.name] === "deployed" || row.progress[e.name] === "published"))
                : [];

            const allCards = [...cards, ...completeCards];
            const cardHtml = allCards.map(row => {
                const ticketUrl = buildTicketUrl(row.storyId);
                const idHtml = ticketUrl
                    ? `<a href="${escapeHtml(ticketUrl)}">${escapeHtml(row.storyId)}</a>`
                    : escapeHtml(row.storyId);
                const staleTag = row.isStale ? ` ⏰` : "";
                const state = row.progress[env.name];
                return `<div class="card">
  <div class="card-id">${idHtml}${staleTag}</div>
  <div class="card-age">${row.ageDays}d old</div>
  <div class="card-state">${stateLabel(state)}</div>
</div>`;
            }).join("") || `<div class="empty-col">Nothing here</div>`;

            return `<div class="col"><div class="col-header">${escapeHtml(env.label)}</div>${cardHtml}</div>`;
        }).join("");

        return `<div class="kanban">${columns}</div>`;
    }

    private _loadingHtml(): string {
        return `<html><body style="padding:16px;font-family:var(--vscode-font-family)">Loading pipeline…</body></html>`;
    }

    private _dispose(): void {
        StoryPipelinePanel.current = undefined;
        this._panel.dispose();
        this._disposables.forEach(d => d.dispose());
    }
}
```

- [ ] **Step 3: Register `sfDevops.openPipelineView` in extension.ts**

Add import:
```typescript
import { StoryPipelinePanel } from "./providers/StoryPipelinePanel";
```

Add inside the `context.subscriptions.push(...)` block:
```typescript
vscode.commands.registerCommand("sfDevops.openPipelineView", () => {
    StoryPipelinePanel.createOrShow(gitHelper, bbClient, context);
}),
```

- [ ] **Step 4: Add `sfDevops.openPipelineView` to package.json**

In `"contributes"."commands"`:
```json
{
    "command": "sfDevops.openPipelineView",
    "title": "Open Story Pipeline View",
    "icon": "$(table)",
    "category": "Salesforce DevOps"
}
```

- [ ] **Step 5: Add pipeline link to StoryWebviewProvider "more actions" footer**

In `src/providers/StoryWebviewProvider.ts`, find the `moreActions` variable in `_getWebviewHtml`. Add a Pipeline link:

```typescript
const moreActions = onFeatureBranch
    ? `<div class="more-actions">
         ${devPublished ? `<a href="#" onclick="send('commitAndPush')">☁ Publish more changes</a> · ` : ""}
         <a href="#" onclick="send('syncBranch')">🔄 Sync with ${baseBranch}</a> ·
         <a href="#" onclick="send('openPipeline')">📊 Pipeline</a>
       </div>`
    : `<div class="more-actions"><a href="#" onclick="send('openPipeline')">📊 Pipeline</a></div>`;
```

Handle the `openPipeline` message in `onDidReceiveMessage`:
```typescript
case "openPipeline":
    vscode.commands.executeCommand("sfDevops.openPipelineView"); break;
```

- [ ] **Step 6: Compile**

```bash
npm run compile
```
Expected: zero errors. Fix any missing imports in `StoryPipelinePanel.ts` — `getEffectiveRole` is in `../RoleManager`, all others in `../config` or `../StoryProgress`.

Correct the import for `getEffectiveRole`:
```typescript
import { getEffectiveRole } from "../RoleManager";
import { getEnvironments, buildTicketUrl, canPromote, extractStoryId, getFeatureBranchPrefix, ResolvedEnvironment } from "../config";
```

- [ ] **Step 7: Manual verification**

Launch Extension Development Host. In the Current Story panel, click "📊 Pipeline" in the footer. The Pipeline panel opens. Verify both Swimlane and Board views render. Verify the toggle switch works. Verify the refresh button reloads story progress.

- [ ] **Step 8: Commit**

```bash
git add src/providers/StoryPipelinePanel.ts src/GitHelper.ts src/extension.ts src/providers/StoryWebviewProvider.ts package.json
git commit -m "feat: multi-story pipeline panel with Swimlane and Kanban views"
```
