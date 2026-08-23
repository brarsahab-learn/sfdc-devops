You are an expert TypeScript and VS Code Extension developer. This is the `sf-devops` VS Code extension, currently at version **3.0.1**, implementing an **Org-per-Branch Dual-Track Workflow** with an automated **2GP Packaging Release Gate & Documentation Engine**.

### High-Level Architecture

1. **Primary Sprint Track (Standard Metadata):**
   * Development flows: `feature/*` -> `qa` -> `uat` -> `main`.
   * Standard Salesforce flat directory structure (`force-app/main/default`) is used on all primary branches.
   * Day-to-day deployments to sandboxes use standard CLI metadata deploys (`sf project deploy start`), with NO packaging builds during sprints.
   * `main` (prod) is deployed by a separate DevOps team/extension — this extension only takes a story up to UAT (see `../USER_GUIDE.md`).

2. **Dedicated 2GP Release Gate (Triggered from `uat`):**
   * An Admin command (`SF-Ops: Prepare 2GP Beta from UAT`) initiates 2GP packaging.
   * It creates a new transient branch `2gp-beta/vX.Y.Z` branched directly from `origin/2gp-main` (`sfDevops.packageBaselineBranch`).
   * It compares `origin/uat` (or `sfDevops.packagingSourceBranch`) against `origin/2gp-main`, under `sfDevops.packaging.sourceBase`.
   * It segregates changed files based on `sfDevops.packaging.patchOverrides` / `excludedMetadata` glob rules (see "Managed vs. unmanaged categorization" below):
     - Core/passable metadata -> `sfDevops.packaging.managedTarget`
     - Components with server errors, patch overrides, or custom configs -> `sfDevops.packaging.unmanagedTarget`
   * It automatically generates a release notes document at `{docsDirectory}/vX.Y.Z-RELEASE-NOTES.md` capturing categorized modified metadata and git work items/commits.
   * It increments the version in `sfdx-project.json`, commits, pushes `2gp-beta/vX.Y.Z`, and creates a Pull Request targeting `sfDevops.packageBaselineBranch` with the release notes injected into the PR description body.

---

### Managed vs. unmanaged categorization (release-gate reference)

Real-world categorization rules a `sfDevops.packaging.excludedMetadata` / `patchOverrides` config should be able to express (see the source project's `UNMANAGED_PACKAGE_GUIDE.md` for the full narrative — this is the condensed, tool-facing version):

- **Structural exclusions** — never packaged, route straight to `unmanagedTarget`: `**/applications/**`, `**/approvalProcesses/**`, `**/groups/**`, `**/queues/**`, `**/flexipages/**`, `**/permissionsets/**`, `**/permissionsetgroups/**`, `**/workflows/**`, `**/tabs/**`, `**/pages/**` — each for a platform-restriction or deliberate ISV-strategy reason, not a bug.
- **Standalone duplicates** — components whose name ends in `Standalone` (or a byte-identical namesake already in `managedTarget`) are deliberate, hand-built parallel implementations. Never auto-move these; never diff-sync them against their managed counterpart.
- **Override wrappers** — thin Aura wrappers embedding one LWC, used only because the New/Edit button override picker requires `lightning:actionOverride` (a bare LWC is never selectable there). Detect by an Aura bundle whose body is a single `<c:XXX>` tag plus event-forwarding.
- **Rule for new/unrecognized files**: flag for manual review rather than guessing. Never propose moving an existing `unmanagedTarget` file into `managedTarget` just because its managed counterpart changed.

---

### Configuration

This extension is fully settings-driven via VS Code `sfDevops.*` settings (see `package.json`'s `contributes.configuration` and `src/config.ts`) — there is no separate `.sf-branch-manager.json` file to maintain.

| Concept | Setting |
|---|---|
| Git provider / repo identity | `sfDevops.gitProvider`, `sfDevops.repoWorkspace`, `sfDevops.repoSlug` |
| Pipeline branches | `sfDevops.environments` (array of `{ name, branch?, orgAlias?, requiredRole?, coverageGate? }`), `sfDevops.baseBranch` |
| Packaging source/target paths | `sfDevops.packaging.sourceBase`, `managedTarget`, `unmanagedTarget`, `docsDirectory` |
| Packaging categorization rules | `sfDevops.packaging.patchOverrides`, `sfDevops.packaging.excludedMetadata` |
| Packaging baseline/source branches | `sfDevops.packageBaselineBranch` (default `2gp-main`), `sfDevops.packagingSourceBranch` |

#### Org alias configuration

Each org alias is an `sf` CLI alias/username, informational/reference today (day-to-day deploys still go through the CI pipeline triggered by a PR merge). Set them as follows:

```jsonc
// .vscode/settings.json
{
  "sfDevops.devOrgAlias": "DevOrg",
  "sfDevops.prodOrgAlias": "ProductionOrg",
  "sfDevops.environments": [
    { "name": "dev" },
    { "name": "qa",  "coverageGate": true,        "orgAlias": "QASandbox" },
    { "name": "uat", "requiredRole": "TrackLead", "orgAlias": "UATSandbox" }
  ],
  "sfDevops.packaging": {
    "devHubOrgAlias": "DevHubOrg"
  }
}
```

This is the settings-driven equivalent of a standalone `orgAliases` block (`{ qa, uat, prod, devHub }`) — each alias lives next to the concept it belongs to instead of a separate top-level map:

- `qa` / `uat` -> the matching entry's `orgAlias` field in `sfDevops.environments`.
- `prod` -> `sfDevops.prodOrgAlias` (reference only — prod deploys stay with the separate DevOps team's process).
- `devHub` -> `sfDevops.packaging.devHubOrgAlias` (reference only — not yet invoked by "Prepare 2GP Beta from UAT" itself).
- `dev` -> `sfDevops.devOrgAlias`, already used to run the Apex coverage check.
