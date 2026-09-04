# SF DevOps — Plan 1: Core Correctness & Role Hardening

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all correctness bugs and security gaps before the extension is rolled out — separate role passwords, role-aware setup check, deleted-file hard block, and role-change audit trail.

**Architecture:** All changes are in existing files. No new files. Foundation that Plans 2 and 3 depend on — must land first.

**Tech Stack:** TypeScript, VS Code Extension API (`vscode.ExtensionContext`, `context.secrets`, `context.globalState`)

**Spec:** `docs/superpowers/specs/2026-09-04-sf-devops-prelaunch-hardening-design.md` §1 and §2

## Global Constraints

- TypeScript strict mode — no `any` casts except where the existing codebase already uses them
- `npm run compile` must pass with zero errors after every task
- No new npm dependencies
- All new settings added to `package.json` `contributes.configuration.properties`
- Compile command: `npm run compile` (runs `tsc -p ./`)
- Manual test: press F5 in VS Code to launch Extension Development Host

---

### Task 1: Per-Role Secrets in RoleManager + Migration

**Files:**
- Modify: `src/RoleManager.ts`

**Interfaces:**
- Produces: `hasRolePassword(context, targetRole)`, `setRolePassword(context, password, targetRole)`, `verifyRolePassword(context, password, targetRole)` (private), `migrateRolePasswordIfNeeded(context)` — all exported except `verifyRolePassword`
- Produces: `promptChangeRole(context, roles, gitHelper?)` — gitHelper optional so call sites in Plan 1 Task 2 can add it without breaking this task

- [ ] **Step 1: Replace the single secret key with per-role helpers**

Replace the top of `src/RoleManager.ts`. Remove `const ROLE_PASSWORD_SECRET = "sfDevops.rolePasswordHash";` and add:

```typescript
const LEGACY_ROLE_PASSWORD_SECRET = "sfDevops.rolePasswordHash"; // migration only — do not use for new reads/writes
const ELEVATED_ROLES = new Set(["Lead", "Admin"]); // keep this line as-is

function rolePasswordKey(role: string): string {
    return `sfDevops.rolePassword.${role}`;
}
```

- [ ] **Step 2: Update `hasRolePassword` to accept targetRole**

Replace:
```typescript
export async function hasRolePassword(context: vscode.ExtensionContext): Promise<boolean> {
    return Boolean(await context.secrets.get(ROLE_PASSWORD_SECRET));
}
```
With:
```typescript
export async function hasRolePassword(context: vscode.ExtensionContext, targetRole: string): Promise<boolean> {
    return Boolean(await context.secrets.get(rolePasswordKey(targetRole)));
}
```

- [ ] **Step 3: Update `setRolePassword` to accept targetRole**

Replace:
```typescript
export async function setRolePassword(context: vscode.ExtensionContext, password: string): Promise<void> {
    await context.secrets.store(ROLE_PASSWORD_SECRET, hashPassword(password));
}
```
With:
```typescript
export async function setRolePassword(context: vscode.ExtensionContext, password: string, targetRole: string): Promise<void> {
    await context.secrets.store(rolePasswordKey(targetRole), hashPassword(password));
}
```

- [ ] **Step 4: Update `verifyRolePassword` (private) to accept targetRole**

Replace:
```typescript
async function verifyRolePassword(context: vscode.ExtensionContext, password: string): Promise<boolean> {
    const stored = await context.secrets.get(ROLE_PASSWORD_SECRET);
    return Boolean(stored) && stored === hashPassword(password);
}
```
With:
```typescript
async function verifyRolePassword(context: vscode.ExtensionContext, password: string, targetRole: string): Promise<boolean> {
    const stored = await context.secrets.get(rolePasswordKey(targetRole));
    return Boolean(stored) && stored === hashPassword(password);
}
```

- [ ] **Step 5: Update `promptChangeRole` to pass targetRole to all helpers**

In `promptChangeRole`, the `if (ELEVATED_ROLES.has(picked))` block currently calls `hasRolePassword(context)`, `setRolePassword(context, newPassword)`, and `verifyRolePassword(context, entered)`. Update all three to pass `picked` as the targetRole:

```typescript
const alreadySet = await hasRolePassword(context, picked);
if (!alreadySet) {
    const newPassword = await vscode.window.showInputBox({
        prompt: `No role-change password is set yet for "${picked}" — set one now (you'll use it for future elevations to this role)`,
        password: true,
        ignoreFocusOut: true,
        validateInput: v => v.trim().length > 0 ? undefined : "Password cannot be empty",
    });
    if (!newPassword) { return false; }
    await setRolePassword(context, newPassword, picked);
} else {
    const entered = await vscode.window.showInputBox({
        prompt: `Enter the "${picked}" role password`,
        password: true,
        ignoreFocusOut: true,
    });
    if (!entered) { return false; }
    if (!(await verifyRolePassword(context, entered, picked))) {
        vscode.window.showErrorMessage("Incorrect password — role not changed.");
        return false;
    }
}
```

- [ ] **Step 6: Add `migrateRolePasswordIfNeeded` export**

Add this function after `setRolePassword`:

```typescript
/**
 * One-time migration: if the pre-Plan-1 single ROLE_PASSWORD_SECRET exists, copy it to
 * the Admin slot (highest privilege) and delete the old key. Idempotent — safe to call
 * on every activation.
 */
export async function migrateRolePasswordIfNeeded(context: vscode.ExtensionContext): Promise<void> {
    const legacy = await context.secrets.get(LEGACY_ROLE_PASSWORD_SECRET);
    if (!legacy) { return; }
    const adminKey = rolePasswordKey("Admin");
    const adminAlreadySet = await context.secrets.get(adminKey);
    if (!adminAlreadySet) {
        await context.secrets.store(adminKey, legacy);
    }
    await context.secrets.delete(LEGACY_ROLE_PASSWORD_SECRET);
}
```

- [ ] **Step 7: Compile and verify zero errors**

```bash
cd "/Users/hardeep.brar/Code (L)/GitHub/SF-DevOps-Extension" && npm run compile
```
Expected: no TypeScript errors. If errors appear in other files that called the old `hasRolePassword`/`setRolePassword` signatures, fix them now (pass `picked` or the relevant role string).

- [ ] **Step 8: Call migration from `activate` in extension.ts**

In `src/extension.ts`, add the import:
```typescript
import { getEffectiveRole, canAccessConfig, promptChangeRole, migrateRolePasswordIfNeeded } from "./RoleManager";
```
Then near the top of `activate()`, after `initLog(context)`:
```typescript
await migrateRolePasswordIfNeeded(context);
```

- [ ] **Step 9: Compile again**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 10: Manual verification**

Launch Extension Development Host (F5). In the Current Story panel, click 👤 role → Lead. Confirm it prompts for a Lead-specific password. Set it. Then click 👤 role → Admin. Confirm it prompts for a *separate* Admin password (not the Lead one). Verify that entering the Lead password for Admin elevation correctly fails.

- [ ] **Step 11: Commit**

```bash
git add src/RoleManager.ts src/extension.ts
git commit -m "feat: separate role secrets per elevated role with legacy migration"
```

---

### Task 2: Role Change Audit Logging

**Files:**
- Modify: `src/AuditLog.ts` (add `"changeRole"` | `"acknowledgeDeletion"` to `AuditOperation`)
- Modify: `src/RoleManager.ts` (add `gitHelper` param to `promptChangeRole`, call `appendAudit`)
- Modify: `src/extension.ts` (pass `gitHelper` to `promptChangeRole`)

**Interfaces:**
- Consumes: `migrateRolePasswordIfNeeded`, per-role secrets from Task 1; `GitHelper.appendAudit` (already exists)
- Produces: `promptChangeRole(context, roles, gitHelper?)` — gitHelper is optional so call sites without it still compile

- [ ] **Step 1: Add new operation types to AuditLog.ts**

In `src/AuditLog.ts`, find `AuditOperation` type and add two new values:

```typescript
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
    | "deployValidate"
    | "signoff"
    | "changeRole"           // NEW
    | "acknowledgeDeletion"; // NEW — used in Task 6
```

- [ ] **Step 2: Add gitHelper parameter to `promptChangeRole`**

In `src/RoleManager.ts`, add an import for `GitHelper` at the top. Since `GitHelper` is a class, import only the type to avoid circular dependencies:

```typescript
import type { GitHelper } from "./GitHelper";
```

Update `promptChangeRole` signature to accept optional gitHelper:

```typescript
export async function promptChangeRole(
    context: vscode.ExtensionContext,
    roles: string[],
    gitHelper?: GitHelper
): Promise<boolean> {
```

- [ ] **Step 3: Call `appendAudit` after successful role change**

In `promptChangeRole`, after `await context.globalState.update(ROLE_STATE_KEY, picked);`, add:

```typescript
if (gitHelper) {
    await gitHelper.appendAudit({
        operation: "changeRole",
        outcome: "success",
        summary: `Role changed from ${current} to ${picked}`,
    });
}
```

- [ ] **Step 4: Pass gitHelper from extension.ts**

In `src/extension.ts`, find the `sfDevops.changeRole` command registration:

```typescript
vscode.commands.registerCommand("sfDevops.changeRole", async () => {
    const changed = await promptChangeRole(context, getRoles());
    if (changed) { storyProvider.refresh(); }
}),
```

Update to pass gitHelper:

```typescript
vscode.commands.registerCommand("sfDevops.changeRole", async () => {
    const changed = await promptChangeRole(context, getRoles(), gitHelper);
    if (changed) { storyProvider.refresh(); }
}),
```

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 6: Manual verification**

Launch Extension Development Host. Change role from Developer to Lead. Open the Audit Trail panel (📋 Audit button). Verify a `changeRole` entry appears with summary "Role changed from Developer to Lead".

- [ ] **Step 7: Commit**

```bash
git add src/AuditLog.ts src/RoleManager.ts src/extension.ts
git commit -m "feat: audit-log every role change including downgrades"
```

---

### Task 3: Password Reset Commands

**Files:**
- Modify: `src/RoleManager.ts` (add `resetRolePassword` and `resetRolePasswordForce`)
- Modify: `src/extension.ts` (register two new commands)
- Modify: `package.json` (add command entries — Command Palette only, no icon/menu)

**Interfaces:**
- Consumes: `verifyRolePassword`, `setRolePassword`, `rolePasswordKey` (internal), per-role secrets from Task 1; `GitHelper.appendAudit` from Task 2
- Produces: exported `resetRolePassword(context, gitHelper)`, `resetRolePasswordForce(context, gitHelper)`

- [ ] **Step 1: Add `resetRolePassword` to RoleManager.ts**

Add after `migrateRolePasswordIfNeeded`:

```typescript
/**
 * Admin-only: prompts for the current Admin password to confirm, then lets the Admin
 * set a new password for any elevated role (Lead or Admin). Command Palette only.
 */
export async function resetRolePassword(
    context: vscode.ExtensionContext,
    gitHelper?: GitHelper
): Promise<void> {
    // Confirm caller is Admin
    const currentRole = getEffectiveRole(context);
    if (currentRole !== "Admin") {
        vscode.window.showWarningMessage("Only Admins can reset role passwords.");
        return;
    }

    // Verify current Admin password
    const adminConfirm = await vscode.window.showInputBox({
        prompt: "Enter your current Admin password to confirm",
        password: true,
        ignoreFocusOut: true,
    });
    if (!adminConfirm) { return; }
    if (!(await verifyRolePassword(context, adminConfirm, "Admin"))) {
        vscode.window.showErrorMessage("Incorrect Admin password — reset cancelled.");
        return;
    }

    // Pick which role to reset
    const targetRole = await vscode.window.showQuickPick(["Lead", "Admin"], {
        title: "Reset password for which role?",
        placeHolder: "Select a role",
    });
    if (!targetRole) { return; }

    const newPassword = await vscode.window.showInputBox({
        prompt: `Set new password for "${targetRole}" role`,
        password: true,
        ignoreFocusOut: true,
        validateInput: v => v.trim().length > 0 ? undefined : "Password cannot be empty",
    });
    if (!newPassword) { return; }

    await setRolePassword(context, newPassword, targetRole);

    if (gitHelper) {
        await gitHelper.appendAudit({
            operation: "changeRole",
            outcome: "success",
            summary: `Admin reset the "${targetRole}" role password`,
        });
    }
    vscode.window.showInformationMessage(`✅ "${targetRole}" role password updated.`);
}
```

- [ ] **Step 2: Add `resetRolePasswordForce` (break-glass) to RoleManager.ts**

```typescript
/**
 * Break-glass: clears ALL role passwords and resets effective role to Developer.
 * No password required — protected by typing "RESET" to confirm.
 * Command Palette only — intentionally buried.
 */
export async function resetRolePasswordForce(
    context: vscode.ExtensionContext,
    gitHelper?: GitHelper
): Promise<void> {
    const confirm = await vscode.window.showWarningMessage(
        "⚠ BREAK-GLASS: This will clear ALL role passwords and reset everyone on this machine to Developer. There is no undo.",
        { modal: true },
        "Continue to confirmation"
    );
    if (!confirm) { return; }

    const typed = await vscode.window.showInputBox({
        prompt: 'Type RESET (all caps) to confirm — this cannot be undone',
        ignoreFocusOut: true,
        validateInput: v => v === "RESET" ? undefined : 'Type exactly "RESET" to proceed',
    });
    if (typed !== "RESET") { return; }

    await context.secrets.delete(rolePasswordKey("Lead"));
    await context.secrets.delete(rolePasswordKey("Admin"));
    await context.globalState.update(ROLE_STATE_KEY, "Developer");

    if (gitHelper) {
        await gitHelper.appendAudit({
            operation: "changeRole",
            outcome: "success",
            summary: "All role passwords cleared via break-glass reset — role reset to Developer",
        });
    }
    vscode.window.showInformationMessage("✅ All role passwords cleared. Role reset to Developer.");
}
```

- [ ] **Step 3: Register commands in extension.ts**

Add these two imports to the existing RoleManager import line:
```typescript
import { getEffectiveRole, canAccessConfig, promptChangeRole, migrateRolePasswordIfNeeded, resetRolePassword, resetRolePasswordForce } from "./RoleManager";
```

Add inside the `context.subscriptions.push(...)` block in `activate()`:

```typescript
vscode.commands.registerCommand("sfDevops.resetRolePassword", async () => {
    await resetRolePassword(context, gitHelper);
}),

vscode.commands.registerCommand("sfDevops.resetRolePasswordForce", async () => {
    await resetRolePasswordForce(context, gitHelper);
}),
```

- [ ] **Step 4: Add commands to package.json**

In `package.json`, in the `"commands"` array, add:

```json
{
    "command": "sfDevops.resetRolePassword",
    "title": "Reset Role Password",
    "category": "Salesforce DevOps"
},
{
    "command": "sfDevops.resetRolePasswordForce",
    "title": "Reset All Role Passwords (Break-Glass)",
    "category": "Salesforce DevOps"
}
```

Do NOT add these to any `menus` — Command Palette only (no `view/title`, no `view/item/context`).

- [ ] **Step 5: Compile**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 6: Manual verification**

Launch Extension Development Host. Open Command Palette (Cmd+Shift+P). Search "Reset Role Password" — confirm both commands appear. Run `Reset All Role Passwords (Break-Glass)` — confirm it shows the warning modal, then requires typing "RESET". After confirming, verify the role resets to Developer.

- [ ] **Step 7: Commit**

```bash
git add src/RoleManager.ts src/extension.ts package.json
git commit -m "feat: add Admin password reset and break-glass role reset commands"
```

---

### Task 4: Role-Aware Org Auth Setup Check

**Files:**
- Modify: `src/SetupCheck.ts`
- Modify: `src/providers/StoryWebviewProvider.ts` (pass effective role to `runSetupChecks`)

**Interfaces:**
- Consumes: `getEffectiveRole(context)` from RoleManager (already imported in StoryWebviewProvider); `canPromote`, `getRoles` from config
- Produces: `runSetupChecks(gitHelper, providerClient, context, effectiveRole)` — adds `effectiveRole: string` as 4th param

- [ ] **Step 1: Update `runSetupChecks` signature in SetupCheck.ts**

Change the function signature from:
```typescript
export async function runSetupChecks(
    gitHelper: GitHelper,
    providerClient: IGitProviderClient,
    context: vscode.ExtensionContext
): Promise<SetupCheckItem[]>
```
To:
```typescript
export async function runSetupChecks(
    gitHelper: GitHelper,
    providerClient: IGitProviderClient,
    context: vscode.ExtensionContext,
    effectiveRole: string = "Developer"
): Promise<SetupCheckItem[]>
```

The default `"Developer"` ensures any existing call site that doesn't pass the role keeps compiling and applies the most restrictive (least-blocking) logic.

- [ ] **Step 2: Pass `effectiveRole` down to `checkOrgAuthentication`**

In the body of `runSetupChecks`, find:
```typescript
items.push(await checkOrgAuthentication(gitHelper.getWorkspaceRoot()));
```
Change to:
```typescript
items.push(await checkOrgAuthentication(gitHelper.getWorkspaceRoot(), effectiveRole));
```

- [ ] **Step 3: Add role-aware logic to `checkOrgAuthentication`**

Update the signature and add a helper that computes which environment slots are truly required for the given role:

```typescript
async function checkOrgAuthentication(workspaceRoot: string, effectiveRole: string = "Developer"): Promise<SetupCheckItem> {
    const slots = getOrgAliasSlots();
    const requiredKeys = getRequiredOrgSlotKeys(effectiveRole);
    // ... rest of existing body, but use requiredKeys to split required vs informational
```

Add the helper above `checkOrgAuthentication`:

```typescript
/**
 * Returns the set of environment slot keys that MUST be authenticated for the given role.
 * Developer: only the first (publish/dev) environment.
 * Lead: first env + any env whose requiredRole rank ≤ Lead's rank.
 * Admin: all environments (existing behaviour).
 */
function getRequiredOrgSlotKeys(effectiveRole: string): Set<string> {
    const envs = getEnvironments();
    const roles = getRoles();
    const roleRank = roles.indexOf(effectiveRole);
    const required = new Set<string>();

    envs.forEach((env, idx) => {
        if (idx === 0) {
            // The publish/dev stage is always required regardless of role
            required.add(env.name);
            return;
        }
        if (!env.requiredRole) {
            // No role restriction — required for all roles
            required.add(env.name);
            return;
        }
        const reqRank = roles.indexOf(env.requiredRole);
        if (reqRank === -1 || roleRank >= reqRank) {
            required.add(env.name);
        }
    });

    return required;
}
```

- [ ] **Step 4: Update `checkOrgAuthentication` body to use `requiredKeys`**

Replace the current `passed` logic with a split: slots in `requiredKeys` are blocking (`required: true`), others are informational. The existing `connectedAliases` record stays — just used for display. Replace the `passed` and `problems` computation:

```typescript
async function checkOrgAuthentication(workspaceRoot: string, effectiveRole: string = "Developer"): Promise<SetupCheckItem> {
    const slots = getOrgAliasSlots();
    const requiredKeys = getRequiredOrgSlotKeys(effectiveRole);
    const slotNames = slots.map(s => s.label).join("/");
    const base = { key: "orgAuthentication", label: `Configured org aliases authenticated (${slotNames})`, required: true };

    const toCheck = slots.filter(s => s.alias);
    const unset = slots.filter(s => !s.alias);
    const results = await Promise.all(toCheck.map(async s => ({ slot: s, connected: await isOrgConnected(s.alias, workspaceRoot) })));

    const connectedAliases: Record<string, boolean> = {};
    for (const s of slots) {
        connectedAliases[s.key] = s.alias ? Boolean(results.find(r => r.slot.key === s.key)?.connected) : false;
    }

    // Only count required slots as failures
    const requiredUnset    = unset.filter(s => requiredKeys.has(s.key));
    const requiredNotAuthed = results.filter(r => requiredKeys.has(r.slot.key) && !r.connected).map(r => r.slot);
    const passed = requiredUnset.length === 0 && requiredNotAuthed.length === 0;

    const problems: string[] = [
        ...requiredUnset.map(s => `${s.label}: no alias set (required for ${effectiveRole})`),
        ...requiredNotAuthed.map(s => `${s.label} (${s.alias}): not authenticated (required for ${effectiveRole})`),
    ];

    // Informational problems (optional — shown in setup UI but not blocking)
    const infoProblems = [
        ...unset.filter(s => !requiredKeys.has(s.key)).map(s => `${s.label}: no alias set (optional for ${effectiveRole})`),
        ...results.filter(r => !requiredKeys.has(r.slot.key) && !r.connected).map(r => `${r.slot.label}: not authenticated (optional for ${effectiveRole})`),
    ];

    return {
        ...base,
        passed,
        detail: passed
            ? `Required org alias(es) configured and authenticated for ${effectiveRole}: ${slots.filter(s => requiredKeys.has(s.key)).map(s => `${s.label}=${s.alias}`).join(", ")}.${infoProblems.length > 0 ? ` (Optional: ${infoProblems.join("; ")})` : ""}`
            : problems.join("; "),
        fixSteps: passed ? [] : [
            "Fill in and authenticate each required org below (Setup Check panel), or",
            ...requiredNotAuthed.map(s => `Run: sf org login web --alias ${s.alias}`),
        ],
        connectedAliases,
    };
}
```

- [ ] **Step 5: Also add `getRoles` and `getEnvironments` imports to SetupCheck.ts if not already present**

Check the existing imports at the top of `src/SetupCheck.ts`. Add `getRoles` to the config import if missing:
```typescript
import {
    getBaseBranch, getEnvironments, getSourceRootFolder, getRepoWorkspace, getRepoSlug,
    getOrgAliasSlots, getRoles,
} from "./config";
```

- [ ] **Step 6: Update StoryWebviewProvider to pass effectiveRole to runSetupChecks**

In `src/providers/StoryWebviewProvider.ts`, find the call to `runSetupChecks` inside `refresh()`:

```typescript
const checks = await runSetupChecks(this._gitHelper, this._bbClient, this._extContext);
```

Change to:

```typescript
const checks = await runSetupChecks(this._gitHelper, this._bbClient, this._extContext, this._userRole);
```

`this._userRole` already calls `getEffectiveRole(this._extContext)` — it's the correct value.

- [ ] **Step 7: Update the `skippedItems` function in SetupCheck.ts**

The `skippedItems()` function hardcodes "Dev/QA/UAT/Prod" in the orgAuthentication label. Update it to use a generic label:

```typescript
{ key: "orgAuthentication", label: "Configured org aliases authenticated", required: true, passed: false, detail: skippedDetail, fixSteps: [] },
```

- [ ] **Step 8: Compile**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 9: Manual verification**

Launch Extension Development Host with role set to Developer. Open Setup Check — confirm that only the DEV org alias row shows ❌ when missing; UAT/Prod rows show ⚠️ (optional). Switch role to Admin, re-open Setup Check — confirm all env rows show ❌ when any is missing.

- [ ] **Step 10: Commit**

```bash
git add src/SetupCheck.ts src/providers/StoryWebviewProvider.ts
git commit -m "feat: role-aware org auth check — Developers no longer blocked by Prod alias"
```

---

### Task 5: Deletion Acknowledgement State in GitHelper

**Files:**
- Modify: `src/GitHelper.ts` (add three new state methods)

**Interfaces:**
- Produces:
  - `getDeletionAcknowledgement(storyId: string, env: string): Promise<{ sha: string } | null>`
  - `setDeletionAcknowledgement(storyId: string, env: string, sha: string): Promise<void>`
  - `clearDeletionAcknowledgement(storyId: string, env: string): Promise<void>`

These store data in a git-dir JSON file alongside the existing state files (same pattern as `sf-devops-coverage.json`, `sf-devops-signoff.json`, etc.).

- [ ] **Step 1: Add the deletion acknowledgement file constant and three methods to GitHelper.ts**

Find the area in `src/GitHelper.ts` where coverage/signoff state methods are defined (look for `isCoveragePassed`, `recordSignoff`, `isSignoffPassed`). Add these three methods near them:

```typescript
private readonly DELETION_ACK_FILE = "sf-devops-deletion-ack.json";

private deletionAckPath(): string {
    return path.join(this.getGitDir(), this.DELETION_ACK_FILE);
}

private readDeletionAcks(): Record<string, { sha: string }> {
    try {
        const raw = fs.readFileSync(this.deletionAckPath(), "utf8");
        return JSON.parse(raw) as Record<string, { sha: string }>;
    } catch {
        return {};
    }
}

private async writeDeletionAcks(data: Record<string, { sha: string }>): Promise<void> {
    fs.writeFileSync(this.deletionAckPath(), JSON.stringify(data, null, 2), "utf8");
}

/** Returns the recorded acknowledgement for a story+env, or null if none. */
async getDeletionAcknowledgement(storyId: string, env: string): Promise<{ sha: string } | null> {
    const key = `${storyId}::${env}`;
    return this.readDeletionAcks()[key] ?? null;
}

/** Records that the developer has manually handled deletions for this story+env at the given feature branch SHA. */
async setDeletionAcknowledgement(storyId: string, env: string, sha: string): Promise<void> {
    const key = `${storyId}::${env}`;
    const data = this.readDeletionAcks();
    data[key] = { sha };
    await this.writeDeletionAcks(data);
}

/** Clears the deletion acknowledgement for a story+env (called when feature branch advances). */
async clearDeletionAcknowledgement(storyId: string, env: string): Promise<void> {
    const key = `${storyId}::${env}`;
    const data = this.readDeletionAcks();
    delete data[key];
    await this.writeDeletionAcks(data);
}
```

Note: `getGitDir()` is an existing private method in GitHelper that returns the `.git` directory path. If it doesn't exist by that name, look for the method that returns the git directory and use that. Check what `sf-devops-coverage.json` uses for its path — follow the same pattern exactly.

- [ ] **Step 2: Compile**

```bash
npm run compile
```
Expected: zero errors. If `fs` or `path` imports are missing, they're already imported — GitHelper already uses both.

- [ ] **Step 3: Commit**

```bash
git add src/GitHelper.ts
git commit -m "feat: deletion acknowledgement state store in GitHelper"
```

---

### Task 6: Deleted File Hard Block in promoteStory.ts

**Files:**
- Modify: `src/commands/promoteStory.ts`

**Interfaces:**
- Consumes: `getDeletionAcknowledgement`, `setDeletionAcknowledgement` from Task 5; `remoteHeadSha`, `featureBranchName` already in scope

- [ ] **Step 1: Add the deletion check block in `runPromotion`**

In `src/commands/promoteStory.ts`, find the section after `preview` is built (around where `shown` and `filesBlock` are built from `preview`). Before the confirmation dialog, add:

```typescript
// Deleted file gate — hard block until manually acknowledged
const deletedInPreview = preview.filter(f => f.change === "deleted");
if (deletedInPreview.length > 0) {
    const featureBranch = featureBranchName(storyId);
    const currentSha = await gitHelper.remoteHeadSha(featureBranch);
    const ack = currentSha ? await gitHelper.getDeletionAcknowledgement(storyId, targetEnv) : null;
    if (!ack || ack.sha !== currentSha) {
        const fileNames = deletedInPreview.slice(0, 5).map(f => f.path.split("/").pop()).join(", ");
        const extra = deletedInPreview.length > 5 ? `, …and ${deletedInPreview.length - 5} more` : "";
        vscode.window.showWarningMessage(
            `❌ ${storyId} deletes ${deletedInPreview.length} metadata component(s) that cannot be deployed automatically yet: ${fileNames}${extra}.\n\nRemove them manually from the ${envUpper} org, then use "Acknowledge manual deletion" in the Current Story panel to unblock this promotion.`,
            { modal: true }
        );
        return;
    }
    // Acknowledged — proceed. Deleted files are already filtered inside runPromotionValidate.
}
```

Place this block AFTER the `preview.length === 0` early return and BEFORE the confirm dialog that shows `confirmMsg`.

- [ ] **Step 2: Soften the existing warning inside `runPromotionValidate` to a log-only message**

In `runPromotionValidate`, find:
```typescript
if (deletedFiles.length > 0) {
    files = files.filter(f => f.change !== "deleted");
    vscode.window.showWarningMessage(...)
```

Change `vscode.window.showWarningMessage(...)` to `log(...)` (or remove the UI message entirely, since the block in `runPromotion` already handled user communication):

```typescript
if (deletedFiles.length > 0) {
    files = files.filter(f => f.change !== "deleted");
    log(`${storyId}: ${deletedFiles.length} deleted file(s) excluded from validate/deploy — acknowledgement confirmed.`);
    if (files.length === 0) {
        return { ran: false, success: true, numberComponentsDeployed: 0 };
    }
}
```

- [ ] **Step 3: Compile**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/promoteStory.ts
git commit -m "feat: hard-block promote/validate when story deletes metadata until manually acknowledged"
```

---

### Task 7: Deletion Acknowledgement UI in StoryWebviewProvider

**Files:**
- Modify: `src/providers/StoryWebviewProvider.ts`

**Interfaces:**
- Consumes: `getDeletionAcknowledgement`, `setDeletionAcknowledgement` from Task 5; `remoteHeadSha`, `featureBranchName`, `previewStoryFiles` from GitHelper; `appendAudit` from GitHelper

- [ ] **Step 1: Add `_getDeletionAckPending` private method**

Add this method to `StoryWebviewProvider` after `_getCoverageBlockedEnv`:

```typescript
/**
 * Returns info about the first promotable env that is blocked by unacknowledged deletions,
 * or null if no such block exists. Used to show the "Acknowledge manual deletion" button.
 */
private async _getDeletionAckPending(storyId: string): Promise<{ env: string; envLabel: string; files: string[] } | null> {
    if (!storyId) { return null; }
    let preview: { path: string; change: "added" | "modified" | "deleted" }[];
    try {
        preview = await this._gitHelper.previewStoryFiles(storyId);
    } catch {
        return null;
    }
    const deleted = preview.filter(f => f.change === "deleted");
    if (deleted.length === 0) { return null; }

    const featureSha = await this._gitHelper.remoteHeadSha(featureBranchName(storyId));
    if (!featureSha) { return null; }

    for (const env of getPromotableEnvironments()) {
        const ack = await this._gitHelper.getDeletionAcknowledgement(storyId, env.name);
        if (!ack || ack.sha !== featureSha) {
            return { env: env.name, envLabel: env.label, files: deleted.map(f => f.path) };
        }
    }
    return null;
}
```

- [ ] **Step 2: Call `_getDeletionAckPending` in `refresh()`**

In the `refresh()` method, after `const coverageBlockedEnv = await this._getCoverageBlockedEnv(storyId);`, add:

```typescript
const deletionAckPending = onFeature ? await this._getDeletionAckPending(storyId) : null;
```

Pass `deletionAckPending` into `_getWebviewHtml()` as a new parameter. Update the `_getWebviewHtml` signature to accept it:

```typescript
private _getWebviewHtml(
    branch: string,
    storyId: string,
    progress: Record<string, string>,
    behindCount: number,
    coverageBlockedEnv: string | null,
    repoOverride: { workspace: string; repoSlug: string } | undefined,
    signoffPassed: Record<string, boolean>,
    localChanges: { staged: string[]; other: string[] } | null,
    timelines: Record<string, EnvTimeline>,
    deletionAckPending: { env: string; envLabel: string; files: string[] } | null  // NEW
): string
```

Update the call in `refresh()` to pass `deletionAckPending` as the last argument.

- [ ] **Step 3: Add the acknowledgement banner in `_getWebviewHtml`**

In `_getWebviewHtml`, after `syncWarning` and before the main card, add:

```typescript
const deletionAckBanner = deletionAckPending
    ? `<div class="warning">
         ⚠ ${storyId} deletes ${deletionAckPending.files.length} component(s) not yet manually removed from ${escapeHtml(deletionAckPending.envLabel)}.
         <br>Remove them from the org, then: <a href="#" onclick="send('acknowledgeDeletion', '${deletionAckPending.env}')">✅ Acknowledge manual deletion for ${escapeHtml(deletionAckPending.envLabel)}</a>
       </div>`
    : "";
```

Add `${deletionAckBanner}` to the HTML body after `${syncWarning}`.

- [ ] **Step 4: Handle the `acknowledgeDeletion` message in `onDidReceiveMessage`**

In the `switch(msg.command)` block, add:

```typescript
case "acknowledgeDeletion":
    if (msg.env) { await this._recordDeletionAck(msg.env); }
    break;
```

- [ ] **Step 5: Add `_recordDeletionAck` private method**

```typescript
private async _recordDeletionAck(envName: string): Promise<void> {
    const branch = await this._gitHelper.currentBranch();
    const storyId = extractStoryId(branch);
    if (!storyId) { return; }
    const featureSha = await this._gitHelper.remoteHeadSha(featureBranchName(storyId));
    if (!featureSha) {
        vscode.window.showWarningMessage("Could not determine the current feature branch SHA — push your branch first.");
        return;
    }
    const env = getEnvironments().find(e => e.name === envName);
    await this._gitHelper.setDeletionAcknowledgement(storyId, envName, featureSha);
    await this._gitHelper.appendAudit({
        operation: "acknowledgeDeletion",
        storyId,
        targetEnv: envName,
        outcome: "success",
        summary: `Deletion manually acknowledged for ${env?.label ?? envName} at SHA ${featureSha.slice(0, 8)}`,
    });
    vscode.window.showInformationMessage(`✅ Deletion acknowledged for ${env?.label ?? envName}. Promote/Validate is now unblocked.`);
    this.refresh();
}
```

Also add `featureBranchName` to the config imports at the top of `StoryWebviewProvider.ts` if not already imported.

- [ ] **Step 6: Compile**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 7: Manual verification**

Launch Extension Development Host. Create a feature branch that deletes a metadata file. Stage and push it. In the Current Story panel, verify the amber deletion banner appears with the Acknowledge link. Click it — confirm the banner disappears and Promote is no longer blocked.

- [ ] **Step 8: Commit**

```bash
git add src/providers/StoryWebviewProvider.ts
git commit -m "feat: deletion acknowledgement UI — banner and one-click acknowledge in Current Story panel"
```

---

### Task 8: Final Package.json Settings for Plan 1

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Verify all new commands from Tasks 1-7 are in package.json**

Confirm the following commands are present in `"contributes"."commands"`:
- `sfDevops.resetRolePassword` (added in Task 3)
- `sfDevops.resetRolePasswordForce` (added in Task 3)

These should already be there from Task 3. If not, add them now (see Task 3, Step 4 for the exact JSON).

- [ ] **Step 2: Compile one final time for Plan 1**

```bash
npm run compile
```
Expected: zero errors.

- [ ] **Step 3: Full Plan 1 smoke test**

Launch Extension Development Host (F5) and verify all Plan 1 behaviours work together:
1. Role elevation to Lead uses Lead-specific password; Admin uses separate Admin password
2. Role changes appear in the Audit Trail
3. Command Palette shows "Reset Role Password" and "Reset All Role Passwords (Break-Glass)"
4. Developer role: Setup Check passes with only Dev org authenticated (QA/UAT/Prod show as ⚠️)
5. Admin role: Setup Check requires all org aliases
6. A story with deleted files shows deletion acknowledgement banner; clicking Acknowledge unblocks Promote

- [ ] **Step 4: Final commit for Plan 1**

```bash
git add package.json
git commit -m "chore: verify package.json commands complete for Plan 1 core correctness"
```
