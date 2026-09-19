# Managed vs. Unmanaged Content Guide — 2GP Release Gate Reference

**Purpose**: this document exists to feed the `sf-devops` VS Code extension's **Dedicated 2GP
Release Gate** (item #2 in `docs/sf-devops.md`'s architecture — the `SF-Ops: Prepare 2GP Beta
from UAT` command). That command diffs `origin/uat` against `origin/2gp-main` and must decide,
per changed file, whether it belongs in `force-app/managed/main/default` (the real 2GP package)
or `force-app/unmanaged/main/default` (deployed manually, never packaged). This document is the
categorized answer key: every reason a file ends up in `unmanaged/` in this repo today, plus the
registry of components that were deliberately *built new* in `unmanaged/` to duplicate or
override something in `managed/`. Treat it as the source of truth for the release gate's
`packaging.excludedMetadata` / `patchOverrides` rule lists in `.sf-branch-manager.json` — when a
new exclusion category or override component is added to this repo, add it here too.

Cross-reference: `CLAUDE.md`'s "Where things live" section and
`docs/2GP_MASTER_DOCUMENTATION.md` Part IV / Issues #25–#41 (why FlexiPages, Permission Sets,
CustomApplications, etc. were pulled out) and Issue #74 (standalone duplicate controllers) carry
the full narrative history behind every rule below. This doc is the condensed, machine-usable
version of that history — the master doc is authoritative if the two ever disagree.

---

## Part 1 — Categories permanently excluded from the managed package

These are **structural exclusions**: an entire metadata type, or a specific object/component
family, that never gets packaged, for a platform-restriction reason or a deliberate ISV-strategy
decision (see `CLAUDE.md` for which is which). A release-gate tool should route any changed file
matching these patterns straight to `force-app/unmanaged/main/default/`, never to `managed/`.

| Category | Path pattern (glob) | Why excluded |
|---|---|---|
| Custom Applications | `**/applications/**` | Nearly all their content is unpackageable `profileActionOverrides` (Salesforce platform restriction — profile-specific Lightning page assignments cannot be packaged at all, 1GP or 2GP); the few packageable App-default overrides aren't worth splitting out on their own. |
| Approval Processes | `**/approvalProcesses/**` | Cannot be packaged (platform restriction). |
| Groups / Queues | `**/groups/**`, `**/queues/**` | Cannot be packaged (platform restriction) — org-specific, created manually per subscriber. |
| FlexiPages | `**/flexipages/**` | Deliberately moved out entirely (Issue #29/#36, Section 9 of the packaging plan) — profile-specific page assignments can never be packaged anyway, plus multiple FlexiPage-specific bugs (cross-object namespace refs, `Global.NewLead`/`Global.NewOpportunity` action validation failures, Dashboard-Id embedding). One clean rule: no FlexiPages ship in the package. |
| Permission Sets / Permission Set Groups | `**/permissionsets/**`, `**/permissionsetgroups/**` | Deliberate ISV strategy decision (Issue #32) — access ships via manual setup, not packaged Profiles/PermissionSets, so subscriber admins control their own access model. |
| Classic Workflow Rules | `**/workflows/**` | Superseded by Flow-based automation; kept only where a legacy org still depends on one. |
| Tabs | `**/tabs/**` | Bound to the CustomApplications they support, which are themselves excluded. |
| Visualforce Pages | `**/pages/**` | Legacy screens not reachable from any packaged entry point. |
| Classic Email Templates (Staff Expense folder) / classic Letterhead | `**/email/Staff_Expense_Management/**`, `**/letterhead/**` | Folder-collision issues at packaging time (Issue #30) — kept manual rather than migrated to Lightning Email Templates for this release (that migration is a flagged future item, not yet started). |
| Specific Flows | `**/flows/**` (selectively — see `force-app/unmanaged/main/flows/CLAUDE.md`) | Only flows with a hard, unpackageable dependency (a referenced Group/Queue/ApprovalProcess, or a manual-setup step) move out; most Flows stay packaged. Do not treat this whole directory as excluded — check the per-flow checklist in that CLAUDE.md before routing a flow file here. |
| Extra fields/list views/web links layered onto an *already-packaged* object | `**/objects/InsureBridge__*/**` (fields/listViews/webLinks only, never the `.object-meta.xml` itself unless it's a wholly foreign object) | Post-install, subscriber-side customizations added on top of a packaged object (e.g. `InsureBridge__Lead__c/fields/Email__c`, `InsureBridge__Initial_Need_Assessment__c/webLinks/New_INA`) — these are intentionally *not* part of the package version so they can be edited without a version bump. |
| Quick Actions (object-specific, not Global Actions) | `**/quickActions/**` (only when the target object/action isn't itself packaged) | Global Quick Actions (`NewTask`, `LogACall`, etc.) stay bare/packaged fine — only object-scoped custom Quick Actions tied to unpackaged objects/flows move here. |

**Rule for the release-gate tool**: match on path first (structural category above); if a file's
path doesn't match any structural exclusion, it's a candidate for `managed/` unless Part 2/3 below
says otherwise.

---

## Part 2 — Standalone duplicate components (new, self-contained, no managed-package dependency)

These are **not overrides** — they are full-copy, parallel implementations of a feature that also
exists in the managed package, built so that class/component can be edited, tested via Anonymous
Apex, or iterated on without a 2GP package version bump, and without touching the live packaged
version at all. Both the managed original and the unmanaged duplicate exist side by side and stay
in sync only by deliberate, separate edits — the release gate should **never** try to auto-merge
or diff-sync one against the other.

**The defining technical reason this pattern exists**: `Utils.cls`, `ErrorLogger.cls`, and
`FeatureControls.cls`'s individual helper methods are `public static`, not `global` — genuinely
inaccessible (`Type is not visible`) from any class outside the `InsureBridge` namespace. A
standalone class cannot call them; it must be **fully self-contained**, with every helper it needs
duplicated as a private method inside the one file. If a standalone class calls a managed-package
class directly, that is a bug, not this pattern — see Part 4's detection rule.

| # | Standalone component(s) | Mirrors (managed) | Why this one exists |
|---|---|---|---|
| 1 | `InitiateRFQStandaloneController.cls` + `initiateRFQActionStandalone` LWC | `initiateRFQActionController.cls` + `initiateRFQAction` LWC | Faster iteration on RFQ creation logic without a package version cycle. |
| 2 | `PolicyCreationController.cls` (the copy in `force-app/unmanaged/main/classes/`) + `policyCreation` LWC | `PolicyCreationController.cls` (managed) + the managed policy-creation LWC | Same iteration-speed reasoning; also backs `policyCreationOverride` (Part 3). |
| 3 | `CreateClaimController.cls` + `createClaim` LWC | (new feature, no direct managed equivalent) | Built standalone from the start; also backs `createClaimOverride` (Part 3). |
| 4 | `CDAccountFundingControllerStandalone.cls` (30 methods, consolidates `CDAccountFundingController.cls`, `CDAccountDashboardController.cls`, `TransactionValidationService.cls`, `TransactionBuilder.cls`, `DateTimeUtil.cls`, `PaymentValidationService.cls`) | Same six managed classes | Built to isolate CD Account Payment/Refund/Transfer/Adjustment processing from a recurring managed-package server-side error (traced to Issue #71's `type`/`transactionType` JSON-key bug, since fixed in the managed original too — see `docs/2GP_MASTER_DOCUMENTATION.md`). Every custom object/field reference is explicitly `InsureBridge__`-prefixed (unmanaged code gets no automatic same-namespace resolution — the opposite of the managed-Apex rule). |
| 5 | `cdAccountDashboardStandalone`, `addNewCDAccountStandalone`, `transferRequestFormStandalone`, `policyPaymentFormStandalone`, `newDepositFormStandalone`, `transactionDetailModalStandalone`, `cancelPolicyEndorsementActionStandalone`, `confirmPaymentAdjustmentStandalone`, `confirmationModalStandalone` (9 LWCs) | `cdAccountDashboard`, `addNewCDAccount`, `transferRequestForm`, `policyPaymentForm`, `newDepositForm`, `transactionDetailModal`, `cancelPolicyEndorsementAction`, `confirmPaymentAdjustment`, `confirmationModal` (managed) | Full LWC-side mirror of #4 — every `@salesforce/apex` import repointed to `CDAccountFundingControllerStandalone`, every internal `c-*` child-component tag repointed to its `*Standalone` sibling, and `confirmationModal` (pure UI, no Apex) was cloned too, not reused, once it turned out reusing the managed bundle directly still creates a package-install-order dependency (`markup://c:confirmationModal` fails to resolve if only the unmanaged bundle is deployed). Every visible heading/title/`masterLabel` in this family is prefixed `#New#` so a developer can tell it apart from the managed original at a glance. |

**Detection heuristic for the release-gate tool**: a component bundle/class whose name ends in
`Standalone` (or, for the three older ones, has a byte-identical namesake already present in
`force-app/managed/main/default/`) is category 2. Its files always live only in
`force-app/unmanaged/main/{classes,lwc}/` — never split across both trees.

---

## Part 3 — Override components (thin wrappers that front a component for a specific UI slot)

These are **not duplicates of business logic** — they're small Aura wrapper components that exist
solely because of one platform restriction: **the standard "New"/"Edit" button override picker
(Object Manager → [Object] → Buttons, Links, and Actions → Override With: Lightning Component)
only ever lists Aura components implementing `lightning:actionOverride` — a bare LWC is never
selectable there, regardless of its `js-meta.xml` targets** (confirmed via Issue #74). Each wrapper
does nothing but embed one LWC (managed or unmanaged) and forward `v.recordId`/events.

| Wrapper (Aura, in `unmanaged/main/aura/`) | Embeds | Overrides |
|---|---|---|
| `createClaimOverride` | `c:createClaim` (**managed** LWC) | `Claim__c`'s standard New button |
| `policyCreationOverride` | `c:policyCreation` (**unmanaged** standalone LWC, Part 2 #2) | Policy creation's standard New-button/flow entry point |
| `callPolicyCreationFlowWrapper` | routes a Quick Action into the policy-creation LWC flow | a Quick Action screen slot |
| `callClaimCreationFlowWrapper` | routes a Quick Action into `c:createClaim` | a Quick Action screen slot |

Also in this family, but generic utility duplicates rather than action overrides:

| Component | Why duplicated into `unmanaged/` |
|---|---|
| `navigateToRecord` (Aura) | A Flow/LWC screen embedded standalone can't reference the managed package's bare `c:navigateToRecord` alias once outside the namespace — duplicated so unmanaged Flows keep working without a namespace-qualified reference. |
| `showToast` (Aura) | Same reasoning — generic utility needed by unmanaged-side Flow screens. |

**Detection heuristic for the release-gate tool**: an Aura bundle implementing
`lightning:actionOverride` whose `.cmp` body is just one `<c:XXX>` tag plus event-forwarding is
category 3. It embeds *either* a managed or an unmanaged LWC — check which by resolving the `c:`
tag against both trees; either is a valid, deliberate configuration.

---

## Part 4 — Rules for the release-gate categorization logic

1. **Never auto-move a file into `force-app/unmanaged/` just because it matches a naming pattern
   like `*Standalone`** — new standalone components are deliberate, hand-built additions (Part 2),
   not something the diff-and-segregate step should invent. The gate's job is classifying changes
   to *existing* files, and flagging genuinely new top-level components for manual review rather
   than guessing which tree they belong in.
2. **A file already under `force-app/unmanaged/` should never be proposed as a move target into
   `force-app/managed/`**, even if it changed on `uat` — these two trees are edited independently
   by design (Part 2's whole point). If the diff shows the *managed* counterpart of a standalone
   pair changed, that's an ordinary managed-package change; it does **not** imply the standalone
   copy needs the same edit, and the tool should not suggest otherwise.
3. **Flag, don't silently classify, any new file whose name doesn't match an existing category** in
   Parts 1–3 — that's exactly the "components with server errors, patch overrides, or custom
   configs" bucket in `docs/sf-devops.md`'s architecture, and it needs a human decision the first
   time, not a heuristic guess.
4. **A standalone class (Part 2) that calls a managed-package class/method directly is a bug**, not
   a valid third pattern — flag it. The only legitimate architecture today is full self-containment
   (see Part 2's explanation of why `Utils.cls`/`ErrorLogger.cls`/`FeatureControls.cls` can't be
   called from outside the namespace at all).
5. **A `@salesforce/schema` or `@salesforce/apex` import inside anything in
   `force-app/unmanaged/main/lwc/` must reference either a standard object/field (bare) or an
   explicitly `InsureBridge__`-prefixed custom object/field/class** — never a bare custom name.
   This is the single most common way a new unmanaged LWC silently breaks once packaged (see
   `CLAUDE.md` rule #6/#9, and the several import fixes made while building Part 2 item #5 above).
   A release-gate lint pass over new/changed files in `force-app/unmanaged/main/lwc/` should grep
   for `@salesforce/(schema|apex)/[A-Za-z]` and flag any hit that isn't `InsureBridge__`-prefixed
   and isn't a known standard object/field.
