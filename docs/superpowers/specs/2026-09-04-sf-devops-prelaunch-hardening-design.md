# SF DevOps Extension — Pre-Launch Hardening Design

**Date:** 2026-09-04  
**Scope:** Approach B — Full pre-launch hardening before rolling out to the dev team.  
**Goal:** Make the extension 100% reliable and error-proof for Developer, Lead, and Admin roles.

---

## 1. Role System Hardening

### 1.1 Separate Secrets per Elevated Role

**Problem:** A single `ROLE_PASSWORD_SECRET` key is shared between Lead and Admin. The Lead password works to elevate to Admin — effectively collapsing two roles into one.

**Design:**
- Replace the single secret key with per-role keys: `sfDevops.rolePassword.Lead` and `sfDevops.rolePassword.Admin`.
- Each secret is set independently the first time that role is first elevated to on a machine.
- `verifyRolePassword(context, password, targetRole)` looks up `sfDevops.rolePassword.${targetRole}`.
- `setRolePassword(context, password, targetRole)` stores under the same per-role key.
- Neither role's password works to elevate to the other.
- **Migration:** On first run after update, if the old single secret exists, it is migrated to the Admin slot only (highest privilege) and the Lead slot is left unset — prompting Lead password creation on first Lead elevation.

### 1.2 Role Changes Audit-Logged

**Problem:** Role elevation/downgrade happens with no audit trail entry.

**Design:**
- `promptChangeRole()` receives `gitHelper` as an additional parameter (already available at every call site in `extension.ts`).
- After every successful role change (including downgrade to Developer), `gitHelper.appendAudit()` is called:
  ```
  operation: "changeRole"
  outcome: "success"
  summary: "Role changed from ${previous} to ${picked}"
  ```
- The Role & Security tab in AdminPanel shows the last 20 role-change events pulled from the audit trail.

### 1.3 Password Reset — Admin-Controlled

**Problem:** No UI recovery path if the Admin password is lost.

**Design:**

**Normal path — `sfDevops.resetRolePassword`:**
- Admin-only command (requires current Admin password to confirm).
- QuickPick: choose which role's password to reset (Lead / Admin).
- Prompts for current Admin password → then new password for the chosen role.
- Visible in Command Palette only (not in Activity Bar or toolbar).

**Break-glass path — `sfDevops.resetRolePasswordForce`:**
- No password required.
- Shows a strongly-worded modal: *"This will clear ALL role passwords and reset everyone on this machine to Developer. There is no undo. Type RESET to confirm."*
- Requires typing `RESET` in an input box before proceeding.
- Clears both `sfDevops.rolePassword.Lead` and `sfDevops.rolePassword.Admin` from secrets storage.
- Resets `sfDevops.effectiveRole` in globalState to `"Developer"`.
- Logs to audit trail: `operation: "changeRole", summary: "All role passwords cleared via break-glass reset"`.
- Command Palette only — intentionally buried.

---

## 2. Setup Check & Deleted File Handling

### 2.1 Role-Aware Org Authentication Gate

**Problem:** The org-auth check requires ALL environments to be authenticated regardless of the user's role. A Developer working only against dev is blocked until Prod is authenticated on their machine — which they should not have access to.

**Design:**
- `runSetupChecks(gitHelper, providerClient, context, effectiveRole)` receives the effective role as a new parameter.
- `checkOrgAuthentication()` splits slots into required vs informational based on role:
  - **Developer:** only the first environment (dev) slot is `required`. All others are informational — shown with ⚠️ (optional) status in Setup Check, not blocking.
  - **Lead:** dev + any environments reachable by the Lead role (those with `requiredRole` ≤ Lead in the roles hierarchy). Prod is informational.
  - **Admin:** all environments required (current behaviour, correct for this role).
- The setup gate UI shows all slots regardless, with unauthenticated non-required slots showing ⚠️ instead of ❌.
- The actual runtime promote gate (which checks `orgAlias` at promotion time) is unchanged — this change only affects the startup gate.

### 2.2 Deleted File Handling — Hard Block with Acknowledgement

**Problem:** Deleted metadata files are silently filtered out of the validate/deploy with a dismissable warning, leaving the target org with stale metadata.

**Design:**

**Phase 1 (this spec):** Hard block with required acknowledgement.
- When `deletedFiles.length > 0` during `runPromotionValidate`, the flow stops entirely.
- A modal is shown:
  > *"❌ {storyId} deletes {n} metadata component(s) that cannot be deployed automatically yet: [list]. Remove them manually from the {env} org, then acknowledge below to unblock this promotion."*
- A new acknowledgement state key per story+env — `sfDevops.deletionAcknowledged.{storyId}.{env}` — is stored in git-dir state alongside the feature branch HEAD SHA at the time of acknowledgement (same pattern as coverage/signoff state in `GitHelper`).
- The Current Story panel shows a new "⚠ Acknowledge manual deletion" button when this gate is pending, which records the acknowledgement and logs it to the audit trail.
- Only once the acknowledgement is recorded does the validate/promote flow proceed (without the deleted files).
- Acknowledgement is invalidated if a new commit is pushed to the feature branch: at validate time, the stored SHA is compared against the current `origin/{featureBranch}` HEAD; a mismatch clears the acknowledgement and re-triggers the block.

**Phase 2 (future spec):** Generate `destructiveChanges.xml` alongside the deploy manifest for components the SF CLI can handle as deletions. Out of scope for this spec.

---

## 3. Functional Gaps

### 3.1 Multi-Story Pipeline Panel — Dual View

**New file:** `src/providers/StoryPipelinePanel.ts`

A full editor tab panel (same pattern as `DeploymentDashboardPanel`) opened via a new `📊 Pipeline` command (`sfDevops.openPipelineView`), accessible from the Command Palette and from a small icon link in the Current Story panel's "more actions" footer.

**Data source:** `listFeatureBranches()` for local branches + any `feature/*` branches on `origin` not yet local (requires a new `GitHelper.listRemoteFeatureBranches()` method using `git ls-remote --heads origin`). Capped at 50 branches sorted by last commit date — a "Showing most recent 50 stories" note is displayed when the cap is hit. For each, calls `getStoryProgress()` — the same function already used in `StoryProgress.ts`. One refresh cycle shared across both views.

**View toggle:** A `☰ Swimlane` / `⊞ Board` toggle button in the panel toolbar. Selected view persists in `workspaceState`.

**Swimlane view (default):**
- Rows = stories (feature branches), sorted by last commit date descending.
- Columns = environments (from `getEnvironments()`).
- Each cell: color-coded badge showing the story's state in that env — 🟢 Done, 🔄 PR Open, 🧪 Validating, ⚠️ Pending, 🔒 Locked, ○ None.
- Clicking an actionable cell (based on current role) opens the Deployment Dashboard for that env (passive — no branch switch) or, for Promote/Validate actions, opens the multi-story picker pre-filtered to that env (same picker `sfDevops.promoteEnv` already uses). Branch checkout is never triggered automatically from this panel.
- Story ID in first column links to the ticket URL if `ticketBaseUrl` is configured.
- Stale stories (see §4.1) shown with ⏰ badge on the row.

**Kanban Board view:**
- Vertical columns per environment.
- Each story appears as a card in the column matching its current active stage (furthest non-done, non-locked environment).
- Cards show: story ID, age in days, next action button (role-filtered).
- Stories fully deployed appear in the last column with ✅ Complete.
- Empty columns show a dim "Nothing here" placeholder.

**Refresh:** Manual ↻ button only — panel does not auto-poll.

### 3.2 PR Description Auto-Generation

**Problem:** The browser opens to a blank PR description every time.

**Design:**
- `openPromotionPR()` in `promoteStory.ts` constructs a PR body string:
  - Story ID and ticket link (from `buildTicketUrl`)
  - Changed metadata grouped by type (from `buildPackageXml`) — e.g. "ApexClass (3), CustomObject (1), Flow (2)"
  - Target environment label
  - Validation result: component count
  - Template: `"## {storyId}\n\n{ticketUrl}\n\n### Metadata\n{typeList}\n\n### Validation\n✅ {n} component(s) validated against {env}"`
- `IGitProviderClient.buildPrUrl(fromBranch, toBranch, repoOverride, body?)` gains an optional `body` parameter.
- `BitbucketClient.buildPrUrl` appends `&description={encodedBody}` to the URL.
- `GitHubClient.buildPrUrl` appends `&body={encodedBody}` to the URL.
- Both providers support prefilled PR descriptions via URL query params — no API call needed.

### 3.3 Rollback / Redeploy Known-Good SHA

**Problem:** No recovery path when a deploy breaks an org.

**Design:**
- The Deployment Dashboard environment header gains a `⏪ Redeploy last known-good` link, shown only when `lastDeploy` exists and the current branch HEAD differs from `lastDeploy.sha`.
- Clicking shows a modal: *"Redeploy {env} to commit {shortSha} ({deployedAt}, {n} components)? This will check out that commit and run a full deploy."*
- Restricted to the same role required to promote into that environment.
- Execution:
  1. Uses the same `warnUncommittedChanges` guard (with `offerStash: true`) already used in `promoteStory.ts` — refuses or stashes if there are uncommitted local changes, since a branch checkout is about to happen.
  2. Creates a temporary local branch `sf-devops-rollback-{env}` from `lastDeploy.sha` (the remote env branch's last known-good commit, not the current HEAD).
  3. Calls `runDeploy()` with `sourceDirs: []` (full source root — same as "Deploy ALL" in the Dashboard).
  4. On success: checks back out the original branch, deletes the temp branch, updates deploy state.
  5. On failure: checks back out the original branch; temp branch left in place for investigation; error shown with audit trail link.
- Logged to audit trail: `operation: "deploy", summary: "Rollback deploy — {env} to {shortSha}"`.

### 3.4 Role-Filtered Merge Notifications

**Problem:** The 60-second poller shows a generic merge banner to everyone, regardless of whether they can act on it.

**Design:**
- `checkPendingDeployments()` filters the notification by role: only shown if `canPromote(getEffectiveRole(context), env)` is true for the current user.
- The notification text is enhanced to name the pending stories: *"📦 PROJ-123, PROJ-456 merged into QA — ready to deploy."* Uses `groupChangesByStory()` already in `DeploymentPlanner.ts` to resolve story IDs from the commit range.
- A Developer won't see a "UAT ready to deploy" banner they can't act on.

### 3.5 Conflict Resolution — Open All Conflicted Files

**Problem:** "Open Conflicts" only opens the first conflicted file.

**Design:**
- `reportOperationConflict()` in `promoteStory.ts`: the "Open Conflicts" action opens all conflicted files (up to 8, matching the existing list limit) via `showTextDocument`, then opens the SCM view.
- If more than 8: appends *"...and {n} more — see Source Control"* to the notification.
- The Conflict panel in `StoryWebviewProvider._getConflictHtml()`: each file row becomes a clickable link that sends `viewWorkingFileDiff` for that path, so any specific conflict can be opened from the sidebar too.

---

## 4. UX & Admin

### 4.1 Stale Story Detection

**New setting:** `sfDevops.staleStoryThresholdDays` (default: `14`). Set to `0` to disable.

**Detection:** Age is computed from `git log --max-count=1 --format=%ct <featureBranch>` — already a pattern used in `GitHelper`. A story is stale if last commit age exceeds the threshold AND it is not yet fully deployed.

**Pipeline panel:** Stale stories show a `⏰ Stale (N days)` badge on their row in both Swimlane and Kanban views.

**Current Story panel:** When the active story is stale, an amber warning banner appears above the pipeline:
> *"⏰ PROJ-123 has had no new commits in {N} days — is this story still active?"*

Banner has a dismiss link, persisted per story in `workspaceState` (dismissed state clears if a new commit is detected on the branch).

### 4.2 "Stories Pending My Action" — Lead / Admin

**New command:** `sfDevops.viewPendingActions`

Opens a QuickPick list (not a full panel — fast and focused) showing all stories that the current role can advance right now:
- Stories where the next environment's `requiredRole` ≤ current role AND state is `"open"` (validated, PR open — awaiting human review and merge in the browser), `"merged"` (PR merged into the env branch, needs a Deploy run), or the publish env state is `"published"` and the next promotable env is available to this role.
- Each item: story ID, environment it's blocked at, action needed (`Deploy`, `Promote`, `Review PR`).
- Selecting an item opens the Deployment Dashboard for that env or executes the promote command for that story.

Triggered via:
- A `⚡` icon link in the Current Story panel's "more actions" footer — shown for Lead/Admin regardless of whether the user is on a feature branch (the footer is always rendered; the `⚡` link is conditionally included based on role only).
- Command Palette: `Salesforce DevOps: View Pending Actions`.

### 4.3 Admin Panel — Full-Tab Right-Side View

**New file:** `src/providers/AdminPanel.ts`

A full editor tab panel (same architecture as `DeploymentDashboardPanel`) opened via the existing `⚙ Setup` button in the Current Story panel toolbar — no new toolbar buttons added.

The panel has three tabs:

**Tab 1 — Setup Check:**
- All setup check items as clean cards with ✅/❌/⚠️ status icons.
- Org alias rows with inline edit/save/authenticate/open-in-browser buttons — Admin-only edit, read-only for others with "Ask an Admin to configure" note.
- Required vs optional items visually separated (required in the main list, optional in a collapsible "Optional" section below).
- Sticky footer: Recheck and Confirm buttons.

**Tab 2 — Environments:**
- Admin-only editing. Lead/Developer see a read-only pipeline diagram: `DEV → QA → UAT → PROD` as connected dots with role/gate labels.
- Admin view: each environment as an editable card showing name, branch, requiredRole (dropdown from `sfDevops.roles`), coverageGate toggle, signoffGate toggle, isProd toggle, 🔴 Lock toggle.
- Add Environment button (appends to list), Remove button per card (confirmation modal), Up/Down arrow buttons for reordering (simpler and reliable in a VS Code webview — drag-and-drop is out of scope).
- A live pipeline preview at the top of the tab updates as environments are edited.
- Writes to workspace `settings.json` via `vscode.workspace.getConfiguration("sfDevops").update("environments", ..., ConfigurationTarget.Workspace)`.

**Tab 3 — Role & Security (Admin-only; tab hidden for other roles):**
- Shows password status per elevated role: Set ✅ / Not set ❌ — never the password itself.
- "Change Lead password" / "Change Admin password" buttons — prompts current password then new password.
- "Reset all passwords" (break-glass) — same flow as `sfDevops.resetRolePasswordForce`.
- Last 20 role-change audit events displayed as a read-only timeline.

**Current Story toolbar stays at exactly 4 items:** `👤 Role · 📋 Audit · ⚙ Setup · ↻ Refresh`

### 4.4 Audit Trail Management

**Enhanced:** `src/providers/AuditTrailPanel.ts`

**Filter bar (top of panel):**
- Date range: "Last 7 days / 30 days / 90 days / All time" quick-select + custom date range.
- Operation: multi-select dropdown (Start Story, Commit & Publish, Validate, Promote, Deploy, Sign-off, Role Change, All).
- Outcome: Success / Conflict / Failure / All.
- Story ID: free-text filter.
- Filters applied client-side — no round-trip.

**Export:**
- The existing Export button exports only the **currently filtered view**.
- Quick-pick before save dialog: "JSON" or "CSV" (columns: `timestamp, operation, storyId, targetEnv, outcome, summary`).

**Lifecycle controls — Admin-only toolbar buttons:**

`🗑 Trim` — QuickPick: "Older than 7 / 14 / 30 / 90 days / Custom date." Preview count shown: *"This will remove 47 entries. Continue?"* Hard delete after confirm.

`📦 Archive & Trim` — Same date picker, but forces a save-dialog export of matching entries first. Trim only runs after the export file is saved successfully. The safe path for compliance-sensitive teams.

`🗑 Clear All` — Removes entire log. Modal with strong wording + requires typing `CLEAR` to confirm.

**Auto-trim on startup:**
- New setting: `sfDevops.auditLogRetentionDays` (default: `90`, set to `0` to disable).
- On extension activation, entries older than the threshold are silently removed.
- A single log line records: `"Auto-trimmed {n} audit entries older than {N} days."` — no popup.

**Size guard:**
- If the audit log exceeds 5 MB at read time, a once-per-session warning banner appears in the panel (suppressed after first show until VS Code restarts):
  > *"⚠ Audit log is large ({size} MB) — consider trimming or archiving old entries."*

### 4.5 Network-Aware Polling

**Problem:** `checkPendingDeployments()` runs every 60 seconds unconditionally, logging noise when offline.

**Design:**
- On network failure (catch block in `checkPendingDeployments`), the interval doubles: 60s → 120s → 240s → ... up to a cap of 600s.
- On success, resets to 60s.
- After 3 consecutive failures, a one-time `showWarningMessage`:
  > *"Salesforce DevOps: can't reach origin — working offline. Retrying in {N}s."*
- Subsequent failures are silent until success resets the counter.

---

## 5. New Settings Added to `package.json`

| Setting | Type | Default | Description |
|---|---|---|---|
| `sfDevops.staleStoryThresholdDays` | number | `14` | Days with no new commits before a story is flagged stale. Set to `0` to disable. |
| `sfDevops.auditLogRetentionDays` | number | `90` | Auto-trim audit entries older than this on startup. Set to `0` to disable. |
| `sfDevops.environments[].locked` | boolean | `false` | When true, blocks all promotions into this environment for all roles. |

---

## 6. New Commands Added to `package.json`

| Command | Title | Visibility |
|---|---|---|
| `sfDevops.openPipelineView` | Open Story Pipeline | Command Palette + "more actions" link in Current Story panel |
| `sfDevops.viewPendingActions` | View Pending Actions | Command Palette + `⚡` link in Current Story panel (Lead/Admin only) |
| `sfDevops.openAdminPanel` | Open Admin Panel | Triggered by ⚙ Setup button in Current Story toolbar; Command Palette |
| `sfDevops.resetRolePassword` | Reset Role Password | Command Palette only (Admin-only at runtime) |
| `sfDevops.resetRolePasswordForce` | Reset All Role Passwords (Break-Glass) | Command Palette only |

---

## 7. File Change Summary

### Modified
- `src/AuditLog.ts` — add `"changeRole"` to `AuditOperation` type
- `src/RoleManager.ts` — per-role secrets, audit logging, password reset logic
- `src/SetupCheck.ts` — role-aware org auth check
- `src/commands/promoteStory.ts` — deleted file hard block + acknowledgement, PR body auto-generation, all conflicted files opened
- `src/commands/submitForReview.ts` — stale story warning hook
- `src/providers/StoryWebviewProvider.ts` — stale story banner, `⚡ Actions` link, pass role to setup checks, `⚙ Setup` opens AdminPanel
- `src/providers/DeploymentDashboardPanel.ts` — rollback/redeploy known-good SHA
- `src/providers/AuditTrailPanel.ts` — filter bar, scoped export, trim/archive/clear, auto-trim, size guard
- `src/providers/EnvironmentTreeProvider.ts` — honour `locked` flag
- `src/GitProviderClient.ts` — optional `body` param on `buildPrUrl`
- `src/BitbucketClient.ts` — URL-encode PR body
- `src/GitHubClient.ts` — URL-encode PR body
- `src/GitHelper.ts` — deletion acknowledgement state (with stored feature-branch SHA), stale branch age, role-change audit helper, `listRemoteFeatureBranches()` method
- `src/config.ts` — `staleStoryThresholdDays`, `auditLogRetentionDays`, `environments[].locked`
- `src/extension.ts` — new commands registered, exponential backoff poller, role-filtered notifications, `gitHelper` passed to `promptChangeRole`
- `package.json` — new commands, new settings schema entries

### New
- `src/providers/AdminPanel.ts` — full-tab Admin panel (Setup Check / Environments / Role & Security tabs)
- `src/providers/StoryPipelinePanel.ts` — multi-story Swimlane + Kanban pipeline view with toggle
