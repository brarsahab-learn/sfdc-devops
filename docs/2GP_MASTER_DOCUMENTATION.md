# InsureBridge — Prime Plus 2GP Managed Package: Consolidated Documentation

*Consolidated on 2026-08-05 from six separate documents written during 2GP package planning, cleanup, and deployment troubleshooting; re-condensed 2026-08-10 to cut repetitive boilerplate while preserving every fact, path, and fix.*

## How to use this document

- New to this package? Start with **Part I** (architecture/plan), then **Part IV** (what's not in the package and why).
- Debugging a deploy error right now? Jump straight to **Part III**'s index table, find your error/component type, then read that issue's entry.
- Setting up a fresh org after installing the package? **Part IV** and **Part V**.
- Doing a fresh `sf package version create` triage from scratch? **Part II** is the original phased remediation plan (superseded in detail by Part III, but still a useful template for grouping a fresh error log by root cause).

**A note on paths**: this project's folder layout (which folder holds packaged vs. unmanaged/standalone metadata) has been renamed/restructured multiple times — `unmanaged/`, `force-app/unmanaged/main/default/`, `force-app/main/default/`, and others have each been "current" at different points. Every path quoted below reflects where that content lived *at the time that section was written*. Confirm a path still exists (`find`/`git status`) before acting on it — the underlying content and reasoning stays valid even when the folder holding it has since been renamed.

## Table of Contents

- Part I — Package Architecture & Planning
- Part II — Base Package v1 Deployment Error Remediation Plan
- Part III — Issues & Fixes Master Log (61 entries)
- Part IV — Unmanaged/Standalone Metadata: What's There and Why
- Part V — Manual FlexiPage Assignment Guide
- Appendix — Source Documents

---

# Part I — Package Architecture & Planning

*Source: `docs/2GP PACKAGE PLANNING.md`*

`manifest/Ascend2/primeplus_package.xml` originally described one giant retrieve/deploy manifest for the whole "Prime Plus" org: 417 Apex classes, 1,597 custom fields, 102 custom objects, 293 CMDT records, 129 FlexiPages, 114 LWCs, 125 Permission Sets, 100 Flows, 91 Layouts, 18 classic Email Templates, 2 Profiles, etc. Goal: turn this into a distributable **2nd Generation (2GP) managed package**, editable post-install the way any AppExchange/ISV customer would expect.

**Confirmed decisions:**
1. **Single package** — all metadata in one 2GP package (no base/extension split). Trade-off: any change requires a full package version bump/re-validation, and subscribers install everything even if they only want one module (portal, expense management, etc.). Accepted while the product remains one cohesive offering. Revisit if a subscriber segment ever wants only a subset — easier to split early than after subscribers are live on a monolith.
2. **Namespace**: register one namespace (`primeplus`/`InsureBridge`); all custom objects/fields/metadata get the prefix automatically on push.
3. **Subscriber Editable** as default visibility for CustomField/CustomObject/Layout/CustomMetadata:
   - CustomField (both packaged and subscriber objects), Layout/CompactLayout, ListView/RecordType/QuickAction/FlexiPage: Subscriber Editable.
   - CustomMetadata: record *values* editable, type *definition* locked (so Apex reading it doesn't break) — matches config-driven patterns (`DML_Finalizer__mdt`, `Clone_Config__mdt`, `Document_List_Controls__mdt`, `Country_State_Mapping__mdt`).
   - CustomObject: definition locked; subscribers can always add their own fields (2GP always permits this regardless of the flag).
   - Flow (100): locked by default in managed packages; either expose as Flow Extension/Template where supported, or design extensibility via invocable Apex/subflow inputs — a per-flow decision.
   - Trade-off: broad editability raises support burden (org-specific drift) but matches the requested ISV posture.
4. **Email Templates — ship classic as-is this release.** 18 templates + classic Letterhead, unchanged: `Prime_Plus/` (16): CD_Account_Balance_Limits_reached_Email, ClaimApprovedMail, ClaimClosedMail, ClaimNotifyToInsurer, ClaimRepudiatedMail, ClaimSettledNotification, ClaimUnderQueryNotification, Client_Endorsement_Email, NotifyToClaimant, Send_Endorsement_Request_To_Insurer_Custom, Send_Policy_Request_to_Insurer, Send_Policy_To_Client_Custom, Send_Policy_To_Follower_Custom, Send_QCR_To_Client_Custom, Send_RFQ_To_Insurer, ServiceProviderAppointNotification; `Staff_Expense_Management/` (2): Inform_Central_Travel_Desk_For_Approved_Travel_Request, Send_Email_to_Finance_Team. Known limitation: classic templates are locked post-install (subscribers can't edit subject/body). **Future release item**: migrate all 18 to Lightning Email Templates (`.email-meta.xml` + `EmailTemplateFolder`) + Enhanced Letterhead (`EnhancedLetterhead` metadata type, replacing the classic one), update every Apex lookup (`EmailSendUtlity`, `genericSendEmail`, `LeadEmailServiceHandler`, `TA_Event_WhatsAppNotification`), then mark Subscriber Editable.
5. **Access control: Permission Sets/Groups only.** Drop both `Profile` members from the manifest; confirm the 125 Permission Sets + 18 Permission Set Groups collectively cover everything the 2 profiles granted (coverage diff before removal); subscriber admins assign PSGs post-install (standard ISV pattern).
6. **Other pre-build review items**: RemoteSiteSetting(6)/Settings(11) — check for hardcoded org-specific URLs (MS Graph/Teams) that should be CMDT/Custom-Settings driven instead; StaticResource(9) — confirm no org-specific secrets; CustomLabels(45) — fine as-is; CustomPermission(95) — keep packaged/locked; AuraDefinitionBundle(9) (`RefreshPage`, `cloneActionWrapper`, `showToast`, etc.) vs. LightningComponentBundle(114) — flag Aura→LWC migration as a future follow-up, not a blocker.

**Verification plan**: regenerate a fresh manifest and diff member counts; run `sf package version create` expecting 0 errors (especially Subscriber Editable/CMDT visibility); install into a scratch org and confirm an admin can edit a packaged field's picklist/a Layout/a CMDT record value, and that classic Email Templates still send even though uneditable; confirm profile removal doesn't break login by assigning only PSGs to a test user.

---

# Part II — Base Package v1 Deployment Error Remediation Plan

*Source: `docs/2GP Logs/base_package_v1_remediation_plan.md`. First full triage of a real `sf package version create` error log (210 numbered errors), grouped by root cause into 8 phases. Superseded in detail by Part III's issue-by-issue log, kept as the original grouping and as a triage template.*

Command used throughout: `sf package version create --package "Insurebridge- Primeplus (Beta)" --definition-file config/project-scratch-def.json --target-dev-hub partner@devhub --code-coverage --installation-key waheguru1313 --wait 30`. This 210-error run replaced an earlier 682-error run dominated by two now-resolved cascades (a Visualforce/namespace issue and a `MetadataTriggerHandler` compile failure taking down ~450 unrelated classes).

**Phase 1 — Scratch org feature gates (~9 errors, config-only).** `Account.ChannelProgramLevelName`/`ChannelProgramName` (Channel Programs), `Contact.DepartmentGroup`/`TitleType` (Enhanced Contact), `User.IsPortalEnabled` (Communities/Digital Experiences) all fail to resolve because the corresponding scratch-org feature isn't enabled. Fix: add `"features": ["EnableSetPasswordExpiration", "Communities", "PartnerCommunity", ...]` to `config/project-scratch-def.json`. Communities is mandatory anyway since `engageCommunicationController` (Engage portal) depends on it. Clears 15 errors (#1–4, #97–107) plus dependents.

**Phase 2 — Email Folder + Letterhead (~30 errors, one root cause, still unresolved at time of writing).** `Cannot find folder:Prime_Plus` (#26–41), `no Letterhead named Insurebridge found` (#42–57), the Letterhead's embedded `Document` `Agentforce/Insurebridge_Final.jpeg` also missing (#25), and every WorkflowAlert pointing at these templates (#75–87). Root cause: the `EmailFolder` metadata type isn't in the manifest (only the templates inside it are), and the classic `Letterhead` component + its embedded Document aren't resolving. Fix: add `<types><members>Prime_Plus</members><members>Staff_Expense_Management</members><members>IB_Email_Templates</members><members>Lead_Email_Templates</members><members>Opportunity_Email_Templates</members><name>EmailFolder</name></types>` to the manifest (skip `unfiled$public`); confirm `Insurebridge.letter-meta.xml` exists in source; add the `Document`+folder or repoint the Letterhead at whatever logo asset currently exists.

**Phase 3 — Direct metadata reference fixes (~30 errors, mostly independent):**

| Errors | Component | Issue | Fix |
|---|---|---|---|
| #5–9 | `Policy__c` (5 fields) | Field History Tracking exceeds tracked-field limit | Untrack 1–2 fields, or confirm edition limit |
| #10–13 | 4 Account Record Types | GVS `UpsellOpportunity__c` doesn't exist (it's a field, not a GVS — copy-paste error) | Fix the picklist-value-set reference |
| #14–17 | 4 Contact Record Types | Picklist value `Broker Network` missing from `LeadSource` | Add the value |
| #18 | `Expense_Voucher__c.Finance_Team_Expense_Voucher` | No `Queue` named `Finance_Team` | Confirm Queue metadata included (Queue ≠ Group) |
| #19 | `Expense_Voucher__c.Vouchers_Submitted_to_Finance` | No `Group` named `Finance_Team` | Confirm Group included separately |
| #20 | Address Settings | Can't modify Yukon (YT) label — conflicts with platform-managed picklist | Remove the override; don't ship state/country label customizations |
| #21–24 | 4 Layouts | Stale field refs (`Account.UpsellOpportunity__c`, `Lead.Broker_Business_Location__c`, `Lead.Contact__c`, `Opportunity.Existing_Insurance_Details__c`) | Correct/remove in Layout XML |
| #58 | `SubPolicy__c.Create_Insurer_Commission` | Formula returns Text but field expects Lookup(Account) | Fix formula or field type |
| #143 | `Quote_Response__c.Send_RFQ_Emails` | Self-references nonexistent `Quote_Response__c` field | Correct API name |
| #129 | `Lead_Contact__c` validation rule | Hardcoded org-specific Id (`NQE00000L2sgo...`) in formula | Rewrite by API name, never raw Id |
| #108–127 | ~20 Permission Sets | Missing fields: `Account.Sample_Mulitselect__c`, `Account.goog_alert__Google_Alert_URL__c` (3rd-party pkg), `Contact.DepartmentGroup` (Phase 1), `User.Approver_Permission__c` | Confirm/strip per field; declare Google Alerts as a dependency or remove those grants |

**Phase 4 — MS Graph/Teams broken (~7 errors, new this run).** `MSGraphAPIConnectionCheckupController`: `Invalid type: Schema.Network`, `Variable does not exist: UrlPathPrefix`/`Name`; cascades to its test, `ibconnectAppCheckUp` LWC, and 2 Permission Sets. Root cause: `Schema.Network` is the Experience Cloud sites/networks type — same Communities feature gate as Phase 1. Fix: enable Communities first; if `Schema.Network` still fails, check for a needed Site.com/Experience Cloud license in the scratch-org shape.

**Phase 5 — FlexiPage/App Builder design-time errors (~30 errors).**
- 5.1 `lineItemManager` `childObjectApiName` stale (#158–186, 29 lines) across many Policy/RFQ record pages, naming wrong values (`Premium_Details__c`, `Policy_Premium_History__c`, `Location_Summary__c`, `Location_Detail__c`, `Age_Band__c`, `Limit_of_Indemnity__c`, `Voyage_Description__c`) — objects renamed/restructured without updating the FlexiPage property. Fix per page against current object names in `force-app/main/default/objects/`.
- 5.2 Field/relationship path errors (#144–156) across `Claims_Record_page`, `EndorsementPage`, `Initial_Need_Assessment_Record_Page`, `Lead_Record_Page`, `Payment_Transaction_Record_Page`, `Premium_Type_Pol_Participation_Record_Page1`, `Product_Record_Page`, `Service_Provider_Record_Page` — same renamed-relationship pattern.
- 5.3 Hardcoded/missing Dashboards (#147–148, #150) on `Home_Page_Default`/`Home_Page_Default2`/`LeadHomePage` reference source-org-only Dashboard Ids — package the Dashboards or remove the embedded widgets.
- 5.4 Invalid Tab reference (#157) on `Staff_Expense_Management_Home_Page`'s `launchPadTileList`.
- 5.5 Google Alerts 3rd-party dependency (#144, #152, #110–111, #124) — same as Phase 3; strip or declare as dependency.
- 5.6 ContentAsset logos (#187–188) on `Lead_Management`/`Staff_Expense_Management` — ContentAsset isn't reliably packageable; convert to StaticResource or drop.

**Phase 6 — Flow & Approval Process issues (~30 errors).**
- 6.1 API version mismatch (#59–61, #64, #70, #72–74): `inputConfiguratorMode`/`collectionElements` invalid at API 64.0 — bump `<apiVersion>` to 66.0.
- 6.2 Field integrity (#62–63, #65–69, #194, #203): `Opportunity.Closing_Reason__c`, `Lead.Closure_Reason__c`, `User.Name_Email_Formula__c` — verify exact names/casing.
- 6.3 `LeadCustomFieldMigrationBatchTest` (#88–92): 5 Lead fields reported missing but present in `managed.xml` — likely a deploy-ordering issue, re-check after Phase 1–2.
- 6.4 Missing invocable/subflow/record actions (#190, #192–193, #196–197, #199–201) pointing at Email Alerts/Record actions Phase 2 fixes — expect to clear together; #197/#199 also depend on their own separately-erroring flows (#71, #72).
- 6.5 Opaque "unexpected error" flows (#189, #191, #195, #198, #202, #204–205) — re-validate after Phases 1–2; escalate to Salesforce support if the opaque `ErrorId` persists.
- 6.6 Approval Process issues (#130–142): "insufficient access rights on cross-reference id" and "Required fields are missing: [Component]" — replace hardcoded source-org User/Queue Ids with portable role/formula assignments; fill in missing Component references.

**Phase 7 — Non-packageable/exclude (~2 errors).** #206 `AccessDevOpsCenterNamedCredentials` — internal DevOps Center credential, remove from manifest. #209 `IB_Policy_Management_PS` → `joshdaymentlabs__DataFetcherController` — genuine external package dependency; install+declare it, or strip the reference.

**Phase 8 — Meta error (#210).** Generic "may be attempting to reference features or org settings" wrapper — expected to resolve automatically once Phase 1's feature flags land; not a separate bug.

**Suggested order**: Phase 1 (also likely clears 4 & 8) → Phase 2 → Phase 3 (parallelizable) → Phase 5 → Phase 6 (re-validate first) → Phase 7. Re-run the same `sf package version create` command after each phase and diff against this categorization — the log has changed shape between analyses before, so always re-read fresh.

---

# Part III — Issues & Fixes Master Log

*Source: `docs/MANAGED_PACKAGE_ISSUES_AND_FIXES.md` — the ongoing, numbered record of every problem hit building this package, in discovery order. Every issue keeps its original number; nothing is deleted, only corrected with a later entry when a fix turned out wrong.*

### Index

| # | Title | Category |
|---|---|---|
| 1 | Object/field lookups fail under the namespace | Namespace: Apex lookups |
| 2 | Object-name text comparison breaks under namespace | Namespace: Apex lookups |
| 3 | Record Type lookup by object name breaks under namespace | Namespace: Apex lookups |
| 4 | Backwards field-existence check crashes instead of erroring cleanly | Apex bug |
| 5 | Lookup filter compares ID to text, can never match | Metadata bug |
| 6 | Debug line crashes on empty list | Apex bug |
| 7 | Field-lookup helper: casing + dead code | Apex bug |
| 8 | Hardcoded field-mapping list duplicates shared settings | Maintainability |
| 9 | Unused setting passed around for no reason | Maintainability |
| 10 | Test-only shortcut masked a real namespace bug | Testing |
| 11 | Copy-paste left one leftover reference (`gd`) | Apex bug |
| 12 | Record saving didn't track succeeded IDs after stripInaccessible | Apex bug |
| 13 | Shared helper missing an overload | Apex bug |
| 14 | Test helper didn't set Record Type, picked wrong default | Testing |
| 15 | Permission Sets missing M-D linking field grant (later reverted, see #20/#22) | Permission Sets |
| 16 | Inactive picklist value blocked packaging | CMDT/packaging |
| 17 | Shared test helper fix broke ~80 unrelated tests | Testing |
| 18 | Still-open items (SLA__c column, tmpVar1, testGetBrokerServiceLocationFullChain) | Open items |
| 19 | Permission Set fieldPermissions placed in wrong file position | Permission Sets |
| 20 | Can't set visibility on an always-mandatory M-D field (disproves #15) | Permission Sets |
| 21 | Reading a record silently requires reading its related record too | Permission Sets |
| 22 | Real answer to the M-D relationship restriction (supersedes #15/#20) | Permission Sets |
| 23 | Two absolute rules conflict — the dependent access itself removed | Permission Sets |
| 24 | Unfixable chain traced further (Payment Transaction, Policy Payment) | Permission Sets |
| 25 | Group/Queue/ApprovalProcess can never be packaged — moved to `unmanaged/` | Packaging strategy |
| 26 | The 3 flagged hard dependencies from #25 became real errors | Packaging strategy |
| 27 | Keep the whole Workflow file + Flow together rather than patch | Packaging strategy |
| 28 | Test setup assumed an Approval Process always exists | Testing |
| 29 | Global Quick Action buttons not guaranteed to exist in every org | Packaging strategy |
| 30 | Email templates in "unfiled public" folder collide with target org | Email templates |
| 31 | One Lightning-style template can never live in a custom folder (corrects #30) | Email templates |
| 32 | FlexiPages/Custom Apps/Permission Sets/PSGs moved out — strategy shift | Packaging strategy |
| 33 | Everything moved out still had to point at the right namespace | Namespace: unmanaged metadata |
| 34 | Reverse-direction check: moved-out content pointing back IN | Namespace: unmanaged metadata |
| 35 | Final walk-through of every unmanaged/ category | Namespace: unmanaged metadata |
| 36 | Same-object FlexiPage fields also need the prefix once standalone | Namespace: unmanaged metadata |
| 37 | Regression: standard fields wrongly prefixed; missed tag shape | Namespace: unmanaged metadata |
| 38 | Remaining ~90 errors are validation-scope artifacts, not bugs | Namespace: unmanaged metadata |
| 39 | Two more FlexiPage tag shapes needed the same fix | Namespace: unmanaged metadata |
| 40 | Flow/Workflow/Approval Process namespace sweep + 2 new dependency gaps | Namespace: unmanaged metadata |
| 41 | LWC bundle references need namespace-qualified `componentName`, not a copy | Namespace: unmanaged metadata |
| 42 | Apex-internal code needs the opposite rule from metadata | Namespace: Apex-internal |
| 43 | `Insurebridge__Product__r` — a casing mismatch, not a namespace bug | Namespace: Apex-internal |
| 44 | Apex→LWC boundary: raw SObject return has namespaced JSON keys | Namespace boundary |
| 45 | Namespaced object name used as bare key into a config Map | Namespace boundary |
| 46 | Proactive `__mdt` sweep found 4 more breakage bugs | Namespace boundary |
| 47 | Codified the rule in Utils.cls + closeout sweep (TriggerBase, SB_MaskDataBatch) | Namespace boundary |
| 48 | LWC→Apex boundary: typed SObject param / JSON.deserialize fails hard | Namespace boundary |
| 49 | Performance regression: `Schema.getGlobalDescribe()` per-loop-iteration | Performance |
| 50 | Base Lightning component attributes need `@salesforce/schema` tokens | Namespace boundary |
| 51 | Apex tests needing FLS/CRUD can't rely on org-assigned Permission Sets | Testing |
| 52 | Missing `disableFlows()`; #51's fix needs to move into `@TestSetup` | Testing |
| 53 | `disableFlows()` too blunt; `PermissionSet.Label` collision | Testing |
| 54 | Flow `actionCalls` to Apex invocable actions need the namespace | Namespace boundary |
| 55 | `getRecord` response side (`data.fields`) keyed by real field name | Namespace boundary |
| 56 | `LineItemController`/`lineItemManager.js` internally disagreed on convention | Namespace boundary |
| 57 | `/lightning/cmp/` URLs (WebLinks, `HYPERLINK()`) need namespaced params too | Namespace boundary |
| 58 | Extracted `resolveNamespacedKey` into shared `c/utils`, swept other LWCs | Namespace boundary |
| 59 | 3 more `.put()`/`.get()` instances of #56's bug, found via a side quest | Namespace boundary |
| 60 | Retried LWC sweep found 5 more, including a fail-closed security check | Namespace boundary |
| 61 | #55's own fix didn't compile — relationship names aren't importable fields | Namespace boundary |
| 62 | `global` vs `public` wrapper/DTO types break `@AuraEnabled` calls from outside the namespace | Namespace boundary |
| 63 | Nested-class namespace quirk needs a dummy type-registration property even after `global` | Namespace boundary |
| 64 | `buildSOQLQuery` throws "duplicate field selected" — config supplies a field both bare and namespaced | Namespace boundary |
| 65 | `Utils.resolveFieldApiName` returned the lowercase map key, not the real cased name — a second duplicate-field bug | Apex bug |
| 66 | `getRecordsDynamically`'s own independent duplicate-field-selected bug | Namespace boundary |
| 67 | Email-domain whitelist: blank config silently blocked every email instead of meaning "unrestricted" | Apex bug |
| 68 | Test compile bug: `Account`-typed variable assigned a `Map<String,Object>` return value | Testing |
| 69 | Stray extra closing `</div>` broke `installmentScheduleManager` layout (non-namespace) | Markup bug |
| 70 | Dangling incomplete method syntax error cascaded into two dependent classes and an LWC | Apex bug |
| 71 | `transferRequestForm.js` field-name typo was the real cause of a long-unresolved "internal server error" | Apex bug |
| 72 | Two more `containsKey()`-against-describe-map bugs, one case-sensitivity, one on fields that don't exist | Namespace boundary |
| 73 | `PolicyParticipationReCalculation` hardcoded dynamic-SOQL string replaced with a Utils-resolved field list | Namespace boundary |
| 74 | Standalone unmanaged duplicates for subscriber-side iteration; standard-action overrides need an Aura wrapper, never a bare LWC | Packaging strategy |
| 75 | Package version `ancestorVersion`/`versionNumber` drift recurs whenever a version releases outside this session | Packaging |

---

## Namespace-boundary rules — read this before jumping to specific issues

Issues #1–#3, #32–#61 all trace back to one root cause, discovered incrementally: **once metadata or code ships inside a managed package, every custom object/field name gets the `InsureBridge__` prefix automatically — but which side of any given comparison/lookup carries that prefix, and when, depends entirely on the mechanism involved.** The issues below found ten distinct mechanisms (now catalogued as the ten-rule table in `CLAUDE.md`); rather than re-derive each one, the short version:

1. **Unmanaged/standalone metadata** (#25–#41): resolves bare names only *while still packaged*; needs the explicit prefix once deployed standalone.
2. **Apex-internal code** (#42): the *opposite* rule — bare same-namespace names always resolve automatically (static SOQL, dot-notation, `SObject.get/put` with a literal); adding a prefix is itself a bug (#43).
3. **Apex→LWC return boundary** (#44): a raw returned SObject serializes with namespaced JSON keys; strip via `Utils.stripNamespaceFromRecord(s)`.
4. **Bare Map key vs. namespaced runtime value** (#45, #46, #59): `Map.get()`/`.containsKey()` against a runtime describe result needs `Utils.isSameObjectType`/`resolveFieldApiName`, not direct comparison.
5. **LWC→Apex boundary** (#48): a typed SObject `@AuraEnabled` param or `JSON.deserialize(json, SomeSObject.class)` requires exact namespaced keys — build via `JSON.deserializeUntyped` + `Utils.buildSObjectFromMap`.
6. **LWC template → base Lightning component attributes** (#50): needs a `@salesforce/schema` import, not a hardcoded string.
7. **SOQL bind var against a bare CMDT/Custom-Setting field** — not yet solved generically (see #45's "fifth mechanism").
8. **Flow `actionCalls` → Apex invocable action** (#54): both `<actionName>` and `<nameSegment>` need the prefix.
9. **`getRecord`'s response side** (#55): `data.fields` is keyed by the real (namespaced) name — check both request and response sides independently.
10. **`/lightning/cmp/` component URLs** (#57): prefix the component name *and every query-parameter key*.

Reusable helpers: `Utils.resolveSObjectType`, `Utils.isSameObjectType`, `Utils.resolveFieldApiName`, `Utils.buildSObjectFromMap`, `Utils.stripNamespaceFromRecord`/`stripNamespacePrefix`, `Utils.resolveObjectAndFieldApiName` (Apex); `resolveNamespacedKey` (`c/utils` LWC module, #58).

---

### 1. Object/field lookups failing because of the package namespace

**Symptom**: "Object not found"/"Field not found"/generic script-thrown exceptions on Lightning pages/buttons even though the object/field exists.
**Fix**: built shared `Utils` helper functions that resolve an object/field correctly whether or not the namespace prefix is present; required every lookup site (~20 files) to go through them.

### 2. Comparing an object's name as plain text also breaks under the namespace

**Symptom**: "Unsupported object type for RFQ creation" thrown even for a correctly-typed record.
**Fix**: added a "smart" object-name comparator (`Object__c` == `InsureBridge__Object__c`) instead of plain-text equality.

### 3. Looking up a Record Type by object name also breaks under the namespace

**Symptom**: "Insert failed... Record Type ID: this ID value isn't valid for the user" creating a quote.
**Fix**: resolve the object's real current name first (with/without namespace), then look up the Record Type using that.

### 4. A field-existence check had its logic backwards

**Symptom**: generic system error instead of a helpful message when an invalid field name hit a "load child records" screen.
**Fix**: rewrote the check using the same shared field-lookup helper so a missing field is caught immediately.

### 5. A lookup filter compared a record ID to a name

**Symptom**: "Value does not exist or does not match filter criteria" linking a Contact to a Broker Office Location.
**Fix**: compare the Record Type's actual *name* ("Master") to the text "Master," not an ID to text.
**Note**: this fix reverted multiple times between sessions (file sync/deploy timing, not a bad fix) — re-check this file first if the error reappears.

### 6. A debug/logging line crashed instead of just logging

**Symptom**: "List index out of bounds: 0" converting a record to JSON.
**Fix**: removed a leftover debug line that printed list[0] before checking for empty; the next line already handles empty safely.

### 7. A helper function had two spelling bugs baked in

**Symptom**: real fields reported "not found"; one field checked twice while the real answer was discarded.
**Fix**: made every comparison consistently lowercase (Salesforce field lists come back lowercase); removed dead "calculate and discard" code.

### 8. Hardcoded field-mapping lists duplicating a shared settings file

**Symptom**: not a runtime error — a contact-matching screen hardcoded its own field list instead of using the `Customer Contacts Config` CMDT.
**Fix**: read from the shared CMDT first, fall back to a small hardcoded list only for 2 items (Claim/Contact fields) the CMDT doesn't cover yet — deliberately not added to the CMDT itself, to avoid side-effects on an unrelated feature reading the same CMDT.

### 9. A leftover, unused setting passed around for no reason

**Symptom**: code-cleanliness finding in the "clone a record" feature — an object-lookup snapshot passed through 3 functions, used by none.
**Fix**: removed after confirming nothing depended on it.

### 10. A test-only shortcut was hiding a real bug

**Symptom**: nonsensical placeholder values (e.g. a field literally named "Name") only during automated test runs.
**Fix**: removed the test-only shortcut and fixed the actual namespace-matching bug underneath (same class as #1), so tests and real usage run identical logic.

### 11. Copy-pasted code left one leftover reference behind

**Symptom**: `Variable does not exist: gd` compile error after an apparently-complete fix.
**Fix**: found the second (20 lines further down) leftover reference to the old, deleted name and updated it too. Lesson: search the whole file for every use, not just the first found.

### 12. Saving records didn't properly track which ones succeeded

**Symptom**: a test-data helper for claims wasn't reliably returning new record IDs.
**Fix**: `Security.stripInaccessible()` hands back separate copies of records — explicitly copy new IDs back onto the caller's original list after the safe save.

### 13. A shared helper was missing one of its "flavors"

**Symptom**: `Method does not exist or incorrect signature: void getObjectFields(Schema.SObjectType) from the type Utils` — compile error blocking the build.
**Fix**: added an overload of the field-lookup helper accepting a full `Schema.SObjectType` descriptor directly, not just a name string.

### 14. Test data helper didn't set a Record Type, so it silently picked the wrong one

**Symptom**: "Value does not exist or does not match filter criteria" in an automated test, even with #5's fix in place.
**Fix**: #5 fixed the rule, but the generic "create a test Account" helper never specified a Record Type, so it got whatever the running user's profile default happened to be. Updated the helper to always explicitly request "Master," matching a sibling broker-account helper.

### 15. Permission sets granting a Master-Detail child were missing the linking-field grant

**Symptom**: "IB Finance references Account Voucher Junction that has M-D relationship with Account." (and 33 more, across Account Voucher Junction, Office Location, CD Account, Loss History, Service Provider).
**Fix (initial, later reverted — see #20)**: added "can view this linking field" to every flagged Permission Set. **Wrong**: the M-D linking field is always mandatory/fully-visible and Salesforce rejects any Permission Set statement about it; all 34 additions had to be removed. Real answer: see #18 (open) → #22.

### 16. An inactive picklist option blocked packaging entirely

**Symptom**: "You cannot add a picklist field on a custom metadata type to a managed package while it has inactive values."
**Fix**: removed the old disabled "Not Applicable" option from the Document List Controls settings picklist — a working "NA" option already covered the same meaning.

### 17. A fix for #5 accidentally broke ~80 unrelated tests

**Symptom**: after correctly fixing #5's filter, one remaining test was "fixed" by forcing *every* test Account (org-wide shared helper) to the "Master" record type — which broke ~80 other tests with "Record Type ID: this ID value isn't valid for the user."
**Root cause**: "Master" is Salesforce's generic no-type placeholder, not a real assignable option once custom Account record types exist (Insurer, Customer, Service Provider, etc.).
**Fix**: reverted the shared helper immediately; the one specific test remains open (see #18 → needs a business decision).
**Lesson**: never make a one-off fix inside a shared, widely-reused test-setup helper without checking every other caller.

### 18. Still open / not yet resolved (as of this entry)

- `"No such column 'SLA__c'"` on a claim-timer object that definitely has that field — theory: a timing/visibility issue for a newer object during packaging tests, unconfirmed.
- `"Variable does not exist: tmpVar1"` during a 200-record claim bulk test — name doesn't appear in any written Apex, likely an unidentified Flow.
- `testGetBrokerServiceLocationFullChain` still fails ("Value does not exist or does not match filter criteria") — needs a business decision: is "Master" really the correct required Account record type for this rule, given it isn't normally assignable once other record types exist? (See #17.)

### 19. A Permission Set file rejected a fix because it was placed in the wrong spot

**Symptom**: "Error parsing file: Element fieldPermissions is duplicated at this location in type PermissionSet" on 23 files just fixed in #15.
**Fix**: Permission Set XML requires each setting type grouped together in a fixed order; #15's additions were appended at file-end instead of alongside their own kind. Moved them into place.
**Lesson**: position matters as much as content in these structured files.

### 20. You can't set visibility on a field that's always mandatory (disproves #15)

**Symptom**: "You cannot deploy to a required field: Account_Voucher_Junction__c.Associated_Account__c" across all 19 Permission Sets touched by #15.
**Fix**: removed all 34 "can view this linking field" entries added in #15. The original question (what actually satisfies the M-D relationship error) stays open — see #18 → #22.

### 21. Reading a record silently requires being able to read its related record too

**Symptom**: "Permission Read InsureBridge__Payment_Credit__c depends on permission(s): Read InsureBridge__CD_Account__c" across 4 Permission Sets.
**Fix**: added a matching "can read CD Account" permission to each of the 4 Permission Sets (Payment Credit always points at a required CD Account).

### 22. Found the real answer to the Master-Detail relationship question (supersedes #15/#20)

**Symptom**: "IB System Administrator references Office Location that has M-D relationship with Account." — 38 instances across 5 custom objects (Account Voucher Junction, Office Location, CD Account, Loss History, Service Provider).
**Root cause**: per Salesforce documentation, *"You can't include object permissions for a custom object in a master-detail relationship where the master is a standard object."* Not tunable by any access-level combination — every one of these 5 objects is an M-D child of a standard object (Account/Contact/Opportunity).
**Fix**: removed the object-level permission entry for all 5 objects entirely from every Permission Set — access is inherited automatically from the parent's own permission.
**Follow-up conflict flagged**: CD Account is *also* required reading for Payment Credit (#21), but CD Account can never appear in a Permission Set at all — and this package ships zero Profiles, so Salesforce's usual "grant via Profile" workaround isn't available. Resolved in #23.
**Lesson**: when an error's wording doesn't change no matter what values are tried, the *type* of setting may be disallowed outright — confirm against official docs before more trial and error.

### 23. When two rules truly can't both be satisfied, the dependent access itself has to go

**Symptom**: "Permission Read InsureBridge__Payment_Credit__c depends on permission(s): Read InsureBridge__CD_Account__c" persists after #22 (which is exactly what removed CD Account's permission).
**Fix**: removed Payment Credit's read access (object- and field-level) from all 4 affected Permission Sets — the one piece of the triangle that could be let go. Anyone needing Payment Credit access post-install must build their own permission set outside the package.
**Note left for later**: those same 4 Permission Sets still expose the Payment Credit tab with no underlying read access — a minor, unaddressed inconsistency.

### 24. The "unfixable chain" turned out to be longer than one link

**Symptom**: "Permission Read InsureBridge__Payment_Transaction__c depends on permission(s): Read InsureBridge__Payment_Credit__c" on System Administrator.
**Fix**: mapped every M-D relationship in the package; Payment Credit (blocked via CD Account) also blocks Payment Transaction and Policy Payment. All three removed together from Administrator in one pass; swept every other M-D relationship and confirmed no other gaps.
**Lesson**: once one object is permanently unfixable, check everything depending on it in one pass rather than waiting for each dependent error to surface separately.

### 25. Some setup items can never travel inside the package — moved to `unmanaged/`

**Symptom**: "These entities are not supported: [Group, Queue, ApprovalProcess]" — a hard platform rule, no workaround. Affected: 2 Public Groups (Finance Team, Central Travel Desk), 1 Queue (Finance Team), 3 Approval Processes (Expense Vouchers, Travel Requests).
**Dependency check before moving**: most Flows already check-first with a friendly "not found" fallback; 3 items have a firmer dependency (2 list views tied to the Finance Team group/queue, 1 email alert tied to Central Travel Desk); the 3 Approval Processes are self-contained (adhoc approver choice, no Group/Queue dependency).
**Fix**: moved all 6 items into a new `unmanaged/` folder at the project root, still in source control, deployed by hand/script as a separate step. Added a guide covering the 3 items needing a second look.
**Lesson**: not every packaging error has a configuration workaround — some setup types are simply off-limits, and the right move is relocation, not searching for a settings fix that doesn't exist.

### 26. The 3 flagged hard dependencies from #25 became real errors, as predicted

**Symptom**: "no Queue named Finance_Team found" / "no Group named Finance_Team found" / "no Group named Central_Travel_Desk found."
**Fix, per component**: `Vouchers Submitted to Finance` list view — its filter (status-based) didn't actually depend on the group, so it stayed in the package, made visible to all internal users instead. `Finance Team Expense Voucher` list view — no independent filter, entire purpose was showing the queue's contents; moved to `unmanaged/`. The Central Travel Desk email alert — initially patched to notify the record owner instead, later reconsidered (see #27).
**Lesson**: moving something out because Salesforce won't allow it creates a second, distinct round of work fixing whatever still points at it.

### 27. Sometimes the cleanest fix is to keep related things together, not patch around a gap

**What prompted this**: reconsidering #26's silent-recipient-swap workaround for the Central Travel Desk alert, since it permanently changes real notification behavior.
**Fix**: moved the entire connected chain out together instead of patching: the Travel Request Workflow file (all 3 email alerts + all 8 field updates — classic Workflow bundles everything for an object into one file, no way to split it), the dedicated triggering Flow, and its email template. Confirmed nothing else references any of the three by name. Deliberately did *not* move the shared `Central_Travel_Desk_Available` CMDT flag, since 4 unrelated screens read it too.
**Lesson**: when a fix would quietly change real behavior just to satisfy packaging, consider moving the whole connected piece out together, even if that's a larger scope than the error alone implied.

### 28. Test setup crashed because it assumed an Approval Process would always exist

**Symptom**: "NO_APPLICABLE_PROCESS, No applicable approval process was found" from a shared test-setup helper, failing 15 tests across 2 classes before their real logic ran — direct fallout of #25.
**Fix**: wrapped just the approval-submission line in try/catch, treating a missing process as an expected no-op — neither affected test class's real logic actually depended on the submission succeeding.
**Lesson**: when something moves to manual-only setup, check not just what *references* it by name but what *actively invokes* it at runtime (e.g. `Approval.process`).

### 29. Page action buttons not guaranteed to exist in every org

**Symptom**: "We couldn't validate Quick Action Global.NewLead," then (after fixing that) "...Global.NewOpportunity" — both on two Account record pages, surfacing one after another across separate install attempts.
**Fix**: removed both shortcut buttons (Leads/Opportunities aren't guaranteed enabled in every subscriber org) from both pages, leaving Edit/Enhance Profile/Today's Opportunities untouched.
**Lesson**: built-in convenience buttons need the same cross-org-compatibility scrutiny as any other reference; installer validation surfaces these one at a time, so scan the whole page for every `Global.*` action in one pass.

### 30. Email templates in the "unfiled public" folder collided with the install target's org

**Symptom**: "EmailTemplate Travel Request Approved file is located in both the package... and in either the unfiled-public folder or a user folder in this org" — seen for `genericFilesShare`, then `Travel Request Approved`, confirming a real pattern (16 templates all shared that folder).
**Fix**: moved all 16 templates into a dedicated package-specific public folder; updated the 5 folder-qualified path lookups (Workflow alerts, Approval Process actions) accordingly.
**Correction**: `genericFilesShare` had to move back — see #31.
**Lesson**: anything shipped into the ambient "public" folder is exposed to whatever else already sits there in a subscriber org; a package-owned folder avoids the risk. Distinguish plain-name lookups (safe either way) from folder-qualified lookups (need updating) when moving templates.

### 31. One email template can never live in a custom folder (corrects #30)

**Symptom**: "Prime_Plus/genericFilesShare: Cannot find folder:Prime_Plus" right after #30 moved it there — confusing since the folder clearly existed.
**Root cause**: `genericFilesShare` is a **Lightning-style** template, not classic like the other 30+; Salesforce flatly disallows Lightning templates in a custom folder when packaged this way.
**Fix**: moved back to the built-in public folder (a default folder needs no custom-folder support). The original collision risk never actually reproduced.
**Lesson**: when a "cannot find X" error appears for something that verifiably exists, check for an unsupported property combination (like template type) before assuming a stale build.

### 32. FlexiPages, Custom Apps, Permission Sets, and PSGs moved out entirely — a strategy shift

**What prompted this**: Salesforce doesn't allow `profileActionOverrides`-style layout assignments inside a managed package at all — confirmed via official docs. Of 1,662 total layout-assignment entries across 5 apps, **1,657 were this unpackageable kind**; the remaining 5 referenced source-org profiles (`Sales`, `Placement`, `Servicing`, etc.) that won't exist in any subscriber org anyway (this package ships zero Profiles).
**Decision**: rather than keep a mostly-broken shell for 5/1,662 working assignments, moved FlexiPages, all 5 Custom Applications, all 124 Permission Sets, and all 18 Permission Set Groups into `unmanaged/` — a deliberate choice (not a platform restriction) for a consistent "extra setup" story.
**Cleanup required**: removed 2 working App-default home-page assignments (`Lead_Management`→`LeadHomePage`, `Staff_Expense_Management`→its home page) — now documented manual steps; simplified a hardcoded "Today's Opportunities" Account button that pointed at a moved FlexiPage's internal name plus a stray internal-org record reference; fixed 8 FlexiPage variants (1 Product Group Team-info page + 14 near-identical RFQ page variants) needing a namespaced cross-object field — the first pass of this check missed 13/14 of the RFQ variants by deduplicating on field rather than file; checked all other buttons/list views/layouts/Apex/settings and found nothing else affected beyond 19 Permission Sets controlling app visibility (moving together with the apps, non-issue).
**Tooling**: `scripts/unmanaged-deploy/deploy-unmanaged.sh` deploys the whole `unmanaged/` folder in one pass, namespace-adjusting Permission Sets and FlexiPage cross-object references depending on target org; `unmanaged/MANUAL_FLEXIPAGE_ASSIGNMENT_GUIDE.md` covers the one part that can never be automated (Profile/Record Type page assignment).
**Lesson**: 0.3% packaging success (5/1,662) is a signal to stop trying and move the whole category to documented manual setup. When re-scanning many similar files, verify dedup logic isn't hiding duplicates.

### 33. Everything left behind still had to point at the right place

**What prompted this**: after #32 moved 4 categories out, every reference *inside* that moved content needed to correctly point at the package's own namespace (since it now deploys separately into an org that already has the real package installed).
**Fixed, by category**: Permission Sets (124 files) — every object/field permission, Apex class grant, custom permission grant, Record Type visibility, settings-record access grant prefixed; one field left alone since it belongs to a separate Google integration package. FlexiPages (131) — each page's own declared object prefixed, on top of #32's cross-object fixes. Custom Applications (5) — every object/Record Type/Tab reference prefixed. The Queue, 1 List View, 3 Approval Processes, the Workflow, and the Flow — each had at least one reference fixed; Approval Processes/Workflow also needed file renames (names are built from the object name). Tabs (49, moved out mid-pass) — 33 tied to a packaged object got prefixed; 16 freestanding ones correctly left alone (a mistaken early prefixing of these 16 in Permission Sets was caught and reverted).
**Still open**: 5 freestanding tabs point at a Lightning/Aura component or FlexiPage rather than an object — FlexiPage ones need no change, but the exact namespace-reference format for the Lightning/Aura ones wasn't confirmed against a live org and was deliberately not guessed at (later resolved by #41).
**Lesson**: "move it out" and "make it work once moved" are two separate jobs — the second touches everything the moved files point at, in every direction. Re-check standing assumptions ("tabs are staying put") the moment new information arrives.

### 34. Checking the reverse direction — what moved OUT still had to point back IN correctly

**What prompted this**: a follow-up check in the opposite direction from #33 — does everything that moved out still correctly reference what it needs inside the package, without touching the package itself.
**Found and fixed**: a third-party "Google Alert" RSS feature accidentally captured across Permission Sets and 2 FlexiPages (16 mentions, removed; 2 unrelated Visualforce pages found genuinely belonging to that vendor inside the core package, flagged not touched); 27 objects (including standard Account) had a "default page" setting pointing at an already-moved page — cleaned up. **New cascade found only by this reverse check**: 2 Screen Flows (Claim/Policy creation) failing with an unexplained internal Salesforce error were moved out too, dragging along 2 Quick Actions, 2 Lightning components, and 2 Aura wrapper components (8 pieces total, moved as one unit); one dangling Quick Action button reference on the Policy page layout removed.
**Still unresolved**: the original Screen Flow error was never actually root-caused, only worked around by moving the flows out.
**Lesson**: dependency checks in only one direction are half a job — tracing every reference back to where it points is how the new Flow cascade got discovered.

### 35. The final walk-through of every remaining `unmanaged/` category

**What prompted this**: a comprehensive pass over every category (not just the two — Permission Sets, FlexiPages — already known to need it) before real subscriber deployment.
**Confirmed already correct**: Approval Processes, Workflow, Groups, Queues, List Views, Tabs, Quick Actions, Aura wrappers; the 16 freestanding tabs re-confirmed correct as-is.
**Real gaps found and fixed**: Permission Sets — 11 files granted 3 Custom Settings by bare name (fixed, same class as #33 but for a metadata type not yet checked). FlexiPages — 82 of 131 pages had a bare quick-action-button reference in the action-bar setting (a different part of the file than #32/#33's cross-object fields; fixed and re-verified). Quick Actions — the 2 moved in #34's cascade referenced their Flow bare and used the old unprefixed file-naming convention; both fixed/renamed. LWC — the 2 Lightning components launching the Flows reference the Flow by name via `flow-api-name` and navigate by object API name — both needed the prefix (first time a Flow's *own name* needed this treatment). Flows — the deepest set: a literal SOQL string, record-variable object-type declarations, screen-component config (object bindings, data-table column/field lists), one `Object.ActionName` invocable reference — all fixed.
**Deliberately left alone**: field reads/writes off a Flow variable (rather than declared by tag) — internally consistent, possibly intentional Flow behavior, not confirmed against a real org, not guessed at.
**Tooling update**: `deploy-unmanaged.sh` no longer runs a namespace-detection/transform step — every file under `unmanaged/` is now a permanently, statically prefixed true copy; `apply-namespace-to-metadata.js` kept only as a legacy fallback.
**Lesson**: Custom Settings inside Permission Sets and quick-action buttons inside FlexiPages were both real, separate reference types the smaller earlier sample missed — a full category-by-category walk is what caught them.

### 36. The "same-object field" assumption from #32/#33 was wrong once FlexiPages deploy standalone

**What prompted this**: a real validation log (`docs/2GP Logs/base package v3`) against a test org, ~140 distinct errors across FlexiPages, PSGs, Custom Apps, and one Approval Process.
**The big one**: earlier fixes (#32/#33/#35) only prefixed *cross-object* FlexiPage field references, reasoning that same-object fields resolve automatically. True only while still packaged — once FlexiPages deploy standalone (per #32's decision), there's no packaging context to auto-resolve anything, so *every* custom field reference needs the prefix, same-object or not. Confirmed against the log (e.g. `Age_Band_Record_Page`'s `Record.Min_Age__c`) and fixed comprehensively: **2,638** `<fieldItem>Record.X</fieldItem>` and **1,454** `{!Record.X}` references, checked against every custom field on every object.
**Two more tag shapes, same rule**: `relatedListApiName` (child relationship names — 82 fixed) and `WebLink`/`CustomButton` `actionNames` entries (`CustomButton.Object.ButtonName` — 80 fixed).
**A genuine Apex bug, not namespace**: `childObjectApiName has an invalid value` errors showed an *already-correctly-prefixed* value — root cause was `ObjectPicklistProvider.cls` having its live `Schema.getGlobalDescribe()` logic commented out, permanently falling back to a stale hardcoded bare-name list. Re-enabled the live logic, kept the hardcoded list as fallback.
**A deploy-ordering issue, not content**: Permission Set Groups failed "Cannot create Permission Set Group Components since the following permission set names are invalid" even though every referenced file genuinely exists — PSGs need their component Permission Sets to already exist in-org; fixed by splitting `deploy-unmanaged.sh` into two sequential deploys (Permission Sets first).
**Worked around, not fixable**: `CustomApplication` "invalid cross reference id" on `Lead_Management`/`Staff_Expense_Management` — their `profileActionOverrides` blocks reference source-org-only Profile names; kept in `unmanaged/applications/` as the reference table the assignment guide points to, but a deploy-time transform (`strip-profile-overrides.js`) makes a throwaway stripped copy for the actual deploy. Two Home Page dashboard widgets referencing source-org-only Dashboard Ids — removed the widgets (rest of each page untouched); recreating one is a manual App Builder step.
**Believed stale, not touched**: FlexiPage Quick Action validation errors checked individually and already correct — likely captured before #35's fix landed.
**Lesson**: a rule that holds inside a package's own build transaction does not automatically hold once metadata deploys standalone — any category moving from packaged to standalone needs re-examination, not just its own files' correctness.

### 37. A re-run caught a regression from #36's own fix, plus one more missed tag shape

**What prompted this**: a fresh validation log, 136 errors (down from #36's batch), with 2 new problems.
**The regression**: #36's blanket field-list wasn't filtered to fields ending in `__c` — standard-field override files (mostly under Account: `Name`, `Description`, `Phone`, `Website`, `Type`, `Industry`, `OwnerId`, +31 more) got swept in and wrongly prefixed, most visibly `Record.Name`→`Record.InsureBridge__Name` in 85 FlexiPages (232 occurrences) — `Name` is a pseudo-field, never namespaced. All 38 standard field names reverted across `unmanaged/`, re-verified against a rebuilt, `__c`-filtered list.
**The missed tag shape**: `relatedListFieldAliases`/`adminFilters` hold their own `<valueList>` of bare column/filter field names — fixed across 42 files, leaving non-field aliases like `NAME` untouched.
**Believed resolved/environmental**: `childObjectApiName`/Quick Action errors likely a stale validation run predating #36's Apex fix; PSG/CustomApplication errors likely from running a raw `sf project deploy start --source-dir unmanaged` instead of the two-phase deploy script.
**Lesson**: a "does this field exist" check is only as safe as its candidate list — filter and spot-check the list *before* a blanket sweep runs, not after.

### 38. The remaining ~90 errors are validation-scope artifacts, confirmed via a guaranteed-correct reference

**What prompted this**: a further re-run (136→90 errors) with every prior fix holding.
**Quick Action "couldn't validate" (majority of what's left)**: every referenced Quick Action genuinely exists in `force-app/main/default/quickActions/`. Proof it's not a content bug: `Account.Enhance_Profile` — a standard-object Quick Action needing no prefix — fails identically. Real cause: `unmanaged/quickActions/` only contains the 2 Quick Actions deliberately moved out (#34); every other referenced Quick Action still lives in the core package, invisible to a validator scoped to `unmanaged/` alone.
**`lineItemManager` `childObjectApiName` still invalid**: the #36 Apex fix is confirmed present in source — the target org likely hasn't had the corrected class redeployed yet.
**PSG/CustomApplication errors, unchanged**: only clear via `deploy-unmanaged.sh`'s two-phase deploy, not a raw source-dir deploy.
**No content changes made** — every error individually re-verified against current file state.
**Lesson**: when a "broken" reference and a definitely-correct one fail identically, stop looking at content and start looking at what the validation payload actually includes — check whether the log was generated against `unmanaged/` in isolation and via the documented script vs. a raw deploy.

### 39. Two more genuine content gaps, fixed strictly within `unmanaged/`

**What prompted this**: a request to fix remaining log entries with `force-app` off-limits (the `ObjectPicklistProvider.cls` fix from #36 was intentionally reverted).
**Pipe-delimited filter values**: `adminFilters` on `lst:dynamicRelatedList` sometimes stores `Field__c|OPERATOR|Value` as one string — none of the earlier regexes matched this shape; fixed 10 across 8 files.
**Bare field names in arbitrary component properties**: a broader sweep found 161 more instances across 41 files where an LWC/Aura property (`accountFieldApiName`, `keyFieldApiName`, `feature`, etc. — no single tag name) holds a bare field name as its entire value; fixed against the same `__c`-filtered field list, re-verified with #37's standard-field contamination check (zero touched).
**Confirmed unchanged/out of scope**: Quick Action visibility (still a validation-scope limitation, #38); `lineItemManager` (needs the reverted Apex fix, off-limits this session); PSG/CustomApplication (needs the deploy script).
**Lesson**: the same underlying bug (bare custom field name) hid behind plain field items, merge-field syntax, related-list aliases, pipe-delimited filters, and arbitrary component properties — each needed its own sweep; don't assume a category is done just because the shapes found so far are exhausted.

### 40. `Claim_Creation_Screen_Flow`/`Policy_Creation_Screen_Flow` — the same sweep applied to Flows, plus two new dependency gaps

**What prompted this**: mirroring a field-reference fix from `Policy_Creation_Screen_Flow` onto `Claim_Creation_Screen_Flow` (the third flow in that folder needed no changes) — the first time this bug class was swept for Flow metadata specifically.
**What a real `sf project deploy start --dry-run` against org `pp01` revealed, in sequence** (lazy validation — each fix exposes the next):
- `We can't find the c:Insurebridge__showToast action` — not a namespace bug: the VS Code/Salesforce Extension environment was silently "auto-correcting" files mid-session, wrongly prefixing `c:showToast` (which must *never* carry a prefix — `c:` always means the deploying org's own default namespace) and a standard `Id` field reference. Both reverted by hand — flagged that the editor may re-corrupt a file after it's fixed.
- Field integrity errors on `Get_Final_Policy_Records_Claim.Policy_Start_Date__c`, `MasterPolicy__c`, `Varient__c`, `Cause_of_Loss__c`, `Nature_of_Loss__c`, the `Product__r` relationship, and equivalents on a second Claim variable — same missing-prefix fix; one casing slip (`Insurebridge__`, lowercase b) corrected to `InsureBridge__`.
- Workflow action and 2 Quick Actions (`New_Policy`, `Register_FNOL`) failing with misleading "Required fields are missing: [Component]" — not content bugs: the Quick Actions' `flowDefinition` values were *over*-prefixed when the deployed Flow API name in `unmanaged/` carries no namespace at all; fixed to bare names.
- **Two new, previously-undocumented dependency gaps**, found only by an actual combined deploy: (1) 2 workflow email alerts + both Approval Processes' submission emails had an incorrect prefix that didn't match their real unprefixed template names under `Prime_Plus/`; (2) the `Staff_Expense_Management` email folder's own `.emailFolder-meta.xml` must deploy alongside its templates, not just the templates.
- **First-time discovery**: `Prime_Plus/Travel_Request_Approved`, `Travel_Request_Rejected`, `Travel_Request_Approval_Submission_Email_Template`, `Expense_Voucher_Approval_Submission_Email_Template`, and the `Insurebridge` Letterhead still live under `force-app/managed/main/default/` (inside the 2GP package source), not `unmanaged/` — a deploy of `unmanaged/` alone can never resolve these until they're moved or copied; `deploy-unmanaged.sh` doesn't yet account for this gap.
- **New dependency**: `showToast` Aura component, used via `c:showToast` — since `c:` only resolves within the deploying metadata's own namespace, a copy was added to `unmanaged/main/default/aura/showToast/` (confirmed safe — self-contained, BSD-3-Clause, zero Apex/object dependencies).
**Verification**: scoped `--dry-run` came back 100% clean (49/49 components), then actually deployed clean.
**Lesson**: the first entry to hit this bug class inside Flow/Workflow/ApprovalProcess metadata, and the first time a real deploy (not a read-through) found the errors — which is exactly why it surfaced structural gaps (missing components, the `showToast` duplication) that careful reading alone couldn't have caught, since each file was individually well-formed. Recommend a real `--dry-run` before declaring any `unmanaged/` category done.

### 41. `no LightningComponentBundle named X found` was never actually unfixable — the real convention is a namespace-qualified `componentName`

**What prompted this**: every earlier entry hitting a custom LWC referenced from a FlexiPage (`cdAccountDashboard`, `lineItemManager`, `genericFileUpload`, `engage_communications`, +18 others) had been written off as a validation-scope artifact (#38–#40). Wrong for this category: retrieving `Account_Record_Page3` fresh from a real org where it renders correctly showed the working copy uses `<componentName>InsureBridge:genericFileUpload</componentName>` — colon-separated markup namespace qualification — not the bare `c:` form used in source. The paired `<identifier>` is separately prefixed with `InsureBridge_` (underscore — it's just an arbitrary string ID).
**Fix, across 84 of 131 FlexiPages**: every bare `<componentName>` for 22 confirmed custom LWC bundles (`cdAccountDashboard`, `confirmPaymentAdjustment`, `customerContactManager`, `engageApp`, `engage_communications`, `genericComparisonTable`, `genericFileUpload`, `genericPathComponent`, `genericSendEmail`, `ibConnectApp`, `installmentScheduleManager`, `internalContactManager`, `lineItemManager`, `policyTermsConditionLayout`, `policyTimeline`, `revenueManagementDashboard`, `rfqCoveragePanel`, `slaTimer`, `subPolicyView`, `termsConditionLayout`, `updatedPolicyVersionPrompt`, `schedulerConsole`) rewritten to `InsureBridge:X` (376 occurrences); 1 already-malformed reference (`Insurebridge__schedulerConsole`) corrected to the same convention; every `<identifier>` in a matching `componentInstance` prefixed with `InsureBridge_` on top of its existing value (377 occurrences); plus an unrelated fix confirmed from the same reference file — 39 pages missing `hideSlackAction = true` on `force:highlightsPanel`, added.
**Verification**: all 131 files re-parsed as valid XML; grep confirmed zero remaining bare references to any of the 22 components.
**Left untouched**: 4 FlexiPages with an unrelated pre-existing casing bug (`Account.Insurebridge__Enhance_Profile`, lowercase b + trailing space) — not part of this fix.
**Lesson**: "the validator can't see this component, so it's a scope artifact" is only true when there's genuinely no correct cross-package reference syntax. For LWC/Aura markup there is one — the namespace-qualified `<componentName>`. Diff against a real working org copy before writing off a "not found" error as unfixable; this exact assumption sat unquestioned across 4 separate log entries before being caught.

### 42. Apex code has the opposite rule from unmanaged metadata — most of the codebase already gets this right

**What prompted this**: a review of hardcoded custom object/field names across ~40 Apex classes, applying the metadata-namespace concern to Apex for the first time.
**The rule**: Apex lives permanently in `force-app/managed/`, never moved to `unmanaged/`. Static SOQL, static dot-notation, `SObject.get()/.put()` with a hardcoded literal, and dynamic SOQL text built by concatenation are **all namespace-safe already** — Apex resolves same-namespace bare names automatically, both at build and runtime. This is the *inverse* of the unmanaged-metadata rule (#32–#41). Confusing the two is exactly how #43 happened.
**The one real risk**: a hardcoded name is unsafe only when compared/looked up against a **namespace-varying runtime value** (`Schema.getGlobalDescribe()`, a describe-map key, `.getSObjectType().getDescribe().getName()`, or a bare-keyed Map sourced from JSON/CMDT/Custom Labels then looked up with a runtime-namespaced value). Fixed via existing `Utils` helpers: `Utils.cls` itself (`isWhatId`/`isWhoId` used `==` against a bare literal — highest-leverage fix since every other helper calls this class); `InternalContactResolver`, `SLA_Controller`, `TA_Default_Voyage_Mapping`, `engageNotificationController`, `engageRecordDetailController`, `initiateRFQActionController`, `CsvImportController` (same `==`/`!=` pattern); `ComparisonTableController`, `InternalContactResolver`, `ManageCustomerContactsHelper`, `EndorsementController`, `ErrorLogger`, `initiatePolicyActionController` (dynamic SOQL with a pre-resolved literal compared against a namespaced `RecordType.SObjectType` value); `CDAccountFundingController`, `EndorsementController` (`Map`/`SObject.get()` on a hardcoded key).
**Two deeper bugs found while verifying, not from the hint list**: `InternalUserRecordAccessMangement.resetSharingForRecords` grouped by a namespaced runtime object name then did `fieldMap.get(objectType)` against a bare-keyed map from `Label.InternalContactObjectMapping` — would have silently skipped sharing rebuilds for every object type once packaged. `ManageCustomerContactsHelper.getObjectConfig` (the shared choke point behind 5 call sites) had the identical bug — would have made default-customer-contact resolution a near-total no-op. Both fixed with a namespace-tolerant key-resolution helper.
**Correctly left alone**: ~120 of ~150 flagged lines were false positives (log-context labels, UI strings, already-routed through `Utils`). Converged rule: `SObject.get()/.put()` with a literal is safe; only a plain `Map`/describe-map `.get()`/`.containsKey()` against that literal is risky.
**Deliberately excluded**: `ObjectPicklistProvider.cls`'s hardcoded `DEFAULT_OBJECTS` — reverted earlier by explicit user decision to match `lineItemManager`'s unprefixed datasource expectation; not touched again.
**Flagged, not fixed**: `TA_SubPolicy_RematchOrphanCommissions.cls:6` — cosmetic `ErrorLogger` label typo, no functional impact. `engageCommunicationController.cls` — duplicate hand-rolled namespace-stripping constant; fixed by pointing at `Utils.NAMESPACE_PREFIX` instead.
**Lesson**: the metadata-side fix (add a prefix) is the literal wrong answer for Apex-internal code — check which category a file belongs to before pattern-matching a fix from earlier in this log.

### 43. `Insurebridge__Product__r` — a casing mismatch, not a namespace bug

**Symptom**: `Didn't understand relationship 'Insurebridge__Product__r'` cascading into `Variable does not exist`/`Dependent class is invalid` across 12 Apex classes + their tests (`PolicyTermsConditionHandler`, `ExcelDataController`, `initiatePolicyActionController`, `subPolicySetupController`, `engageServiceRequestController`, `EngageFileClaimController`, `CDAccountDashboardController`, `EndorsementController`, `ComparisonTableController`, `engageSearchController`, + dependents like `genericDynamicApexInvoker`), 40 occurrences.
**Root cause**: `Insurebridge__` (capital I, lowercase b) matches *none* of the 3 real casing variants in this project — not `InsureBridge__` (correct), not `insurebridge__` (the literal `sfdx-project.json` registration string) — it's a distinct, incorrect third casing from a manual edit or over-eager find/replace. More importantly, per #42's rule, **it shouldn't have had any prefix at all** — `Product__r` is the default relationship for a bare `Product__c` lookup on `Policy__c`/`Initial_Need_Assessment__c`, and all 12 classes live permanently in `force-app/managed/`.
**Fix**: stripped `Insurebridge__` entirely from all 40 occurrences (removed the prefix, didn't recase it), verified via brace-balance check.
**Lesson**: not every "no such relationship" error is a missing-prefix problem — this was a prefix-that-should-never-have-existed problem, the opposite fix from usual. Check "should this have a prefix at all," not just "is the casing right."

### 44. The Apex→LWC data boundary — a third, distinct namespace rule

**What prompted this**: a report that an LWC read `fields__c` while Salesforce actually returned `Insurebridge__field__c` — looked like a normal missing-prefix bug, but the mechanism is a third, previously undocumented rule.
**The three rules side by side**: (1) unmanaged metadata (#25–#41) needs the explicit prefix once standalone; (2) Apex-internal (#42) never needs one, ever; (3) **this entry** — the Apex code itself is fine (rule 2 still applies), but once an `@AuraEnabled` method returns a raw `SObject`/`List<SObject>` and the platform serializes it to JSON, the JSON keys are the record's real runtime field names — namespace-qualified once packaged. An LWC written against `record.Field__c` silently gets `undefined` post-install: no compile error, no deploy error, just wrong/missing UI data.
**The fix, built once**: `Utils.stripNamespaceFromRecord(SObject)`/`stripNamespaceFromRecords(List<SObject>)` — strips the namespace off every populated key, recursing into populated relationship SObjects — applied at the `@AuraEnabled` return boundary.
**Two shapes, fixed across two sweep rounds of `force-app/managed/main/default/classes/`**: direct return-type (`InternalContactController`, `EndorsementController`, `subPolicySetupController`, `CustomerContactController`, all 8 `CDAccountDashboardController` methods, `LineItemController`); wrapper-class property (`CDAccountDashboardController.TransactionPage`'s `@AuraEnabled List<Payment_Transaction__c> records` — fixed in the constructor).
**Rule followed throughout**: never break a strongly-typed Apex caller — where a method is called by both an LWC and typed Apex/tests, the original was left untouched and a new parallel `@AuraEnabled` wrapper added (`getCustomerContactsForLwc`, `getRecordDetailsForLwc`, `getRecordsDynamicallyForLwc`, `getPremiumDetailsForLwc`) — zero LWC business logic changed, only the import repointed.
**Confirmed safe**: `engageRecordDetailController.getRecordDetails` always resolves to a scalar via `engageUtils.getFieldValue`, never exposes a raw SObject; a handful of other methods had the same shape but no LWC consumer at all (confirmed via grep).
**Lesson**: this bug class produces **no error at all** — every other namespace bug had some validation signal; this one requires reading the LWC's JS against what Apex actually returns. "Does it compile" is not sufficient verification.

### 45. A fourth variant: a namespaced object name used as the bare KEY into a config Map

**What prompted this**: `CustomerContactController.cls`'s `NewLeadContact.put((String)getKeyFieldMap().get(objApiFieldName), ...)` silently putting `null`. `objApiFieldName` came from `Utils.getObjectName(recordId)` (namespaced); `getKeyFieldMap()` was bare-keyed config (`'Contact'`, `'Policy__c'`) never meant to carry a namespace.
**Why a fourth case, not a #42 repeat**: not about adding/removing a prefix — it's a mismatch between two values that were never going to share namespace state: one namespace-qualified runtime value, one namespace-agnostic literal/CMDT/config value. Same "no error at all" danger as #44, discovered via `Map.get()` instead of LWC serialization.
**Fix**: a namespace-tolerant key-resolution helper using `Utils.isSameObjectType` to scan map keys instead of a direct `.get()` — each affected class got its own private copy (no shared base class, to avoid touching unrelated call sites): `resolveMappingValue` (`CustomerContactController`), `resolveConfiguredObjectKey` (`ManageCustomerContactsHelper`), `resolveFieldMappingValue` (`InternalUserRecordAccessMangement`, `IntegrationUtils`), `resolveAccountFieldForObject` (`engageController`), `findMatchingKey` (`InternalContactResolver`), `resolveConfigForObject` (`TAT_ConfigService`).
**Proactive sweep found 6 more classes**, dispatched as 5 parallel audits: `engageController.cls` (`.toLowerCase()` doesn't strip a namespace — a real portal-eligibility break, not cosmetic); `LineItemController.cls` (`equalsIgnoreCase` direct compare, same mismatch — routed through `Utils.isSameObjectType`); `IntegrationUtils.cls` (bare-keyed map from `Integration_Field_Config__mdt.Field_Mappings__c` JSON); `InternalContactResolver.cls` (3 sites keyed from `FeatureFlag__mdt.Payload__c` JSON); `TAT_ConfigService.cls` (shared by `TA_TAT_TriggerHandler`/`SLA_Controller` — one fix covered both callers).
**Confirmed safe** (majority of flagged sites): dynamic-SOQL-only usage, already-tolerant-helper usage, standard-object bare comparisons, SOQL binds where both sides are namespaced, plain descriptive strings — across `ComparisonTableController`, `CustomerEnrichmentService`, `EndorsementController`, `ErrorLogger`, `ExcelDataController`, `FieldSelectorController`, `GSTConfigUtils`, `GenericEmailController`, `GetSFDCsObjectToJSON`, `InternalContactController`, `ManageCustomerContactsHelper`, `PolicyAfterInsertService`, `cloneActionHandler`, `engageCommunicationController`, `genericDynamicApexInvoker`, `getSObjectRecords`, `initiatePolicyActionController`, `initiateRFQActionController`, `TA_Default_Voyage_Mapping`, `InternalUserRecordAccessMangement`, `Utils.cls`, `CDAccountFundingController`, `LineItemController` line ~42.
**A fifth mechanism, deliberately unfixed**: a namespaced runtime value bound into a SOQL `WHERE` clause against a bare CMDT/Custom-Settings text field. Found in `CustomerEnrichmentService.cls` (`Integration_Field_Config__mdt.Object_Name__c`), `GSTConfigUtils.cls` (`GST_Configuration__c.Ref_Object_Name__c`), and mid-sweep, `TA_ContentDocument_PreventDeletion.cls` → `genericFilesController` → `metadataUtils` → `ParseJsonUtility.getValue` (the defective lookup lives inside a generic multi-purpose JSON-path utility — needs a narrow fix, not the reusable helper). All three left as explicit follow-ups (Rule #7 in `CLAUDE.md`).
**Lesson**: #42's "Apex-internal never needs a prefix" is true only when both sides of a comparison are derived the same way at runtime. It fails the moment one side is a namespace-agnostic literal/CMDT/JSON value authored assuming no namespace would ever exist. Ask "where did each side come from and will they diverge once packaged," not "is this Apex."

### 46. A proactive `__mdt` sweep surfaced 4 more total-breakage bugs, 2 guaranteed to fail every call

**What prompted this**: casting a broader net than #45 — every non-test Apex class referencing `__mdt` (~24 files), read in full across 3 parallel audits, hunting comparisons/lookups rather than grepping the string.
**Two guaranteed, unconditional failures**: `cloneActionHandler.cls` (2 sites) — `Clone_Config__mdt.Parent_Object_API_Name__c` (bare) compared with `!=`/forced-boolean logic directly against a namespaced `.getSObjectType().getDescribe().getName()` in `toValidatedRecordId` and `detectManyToMany`; the check was **always true**, throwing on every legitimate call and misclassifying every child relationship as many-to-many. `ExcelDataController.cls` — `Excel_Export_Config__mdt.Parent_Object__c` (bare) via `.equalsIgnoreCase()` against a namespaced value in `validateRecordType` — throws "Record type mismatch" on every call, breaking the entire Excel export feature post-install. Both fixed by swapping for `!Utils.isSameObjectType(...)`.
**Two narrower but real**: `SB_MaskDataQueueable.cls` — `SB_MaskDataConfig__mdt.FieldAPIName__c` (bare) checked via `fields.getMap().containsKey()` against a namespaced describe map — configured custom fields silently drop out of the masking query with no error; fixed via existing `Utils.resolveFieldApiName` (already present, just unused here). `genericFilesController.cls` — a record's own business-data field value (never namespaced by design) used as a key into a namespaced CMDT describe-fields map; fixed by routing through `Utils.resolveFieldApiName`.
**Confirmed safe** across ~20 remaining files after full reads: `TeamsConfigSettingsController`, `GenericDispatcher`, `MSTeamsUtil`, `MSGraphAPIConnectionCheckupController`, `engageUtils` (flagged for awareness only), `FinalizerHandler`, `IntegrationCalloutUtils`, `WhatsappMeetingReminderService`, `engageServiceRequestController`, `InstallmentScheduleController`, `MSErrorLoggerService`, `PolicyAfterInsertService`, `ComparisonTableController`, `metadataUtils`, `MetadataTriggerHandler` (deliberate namespace/local-name split, not a bug), `EngageLogger`, `FeatureControls`, `engageClaimsController`, `FormulaFilter`.
**Confirmed present, not fixed**: the `ParseJsonUtility`/`metadataUtils`/`genericFilesController.controlDeletion` chain re-confirmed, same reasoning as #45.
**Lesson**: the *source* of the bare value (CMDT rows are the densest source of "authored assuming no namespace") matters more than the mechanism — 2 of these 4 bugs used `!=`/`.equalsIgnoreCase()` directly, not a Map at all. The rule is "never compare a CMDT-sourced name to a runtime-namespaced one without `Utils.isSameObjectType`/`resolveFieldApiName`," not "only worry about Maps."

### 47. Codified the rule in `Utils.cls`, then swept every remaining describe-touching file

**What prompted this**: making the concept durable everywhere, not just retroactively applied.
**Action 1**: added "MANDATORY" doc comments on `Utils.isSameObjectType`/`Utils.resolveFieldApiName` in `Utils.cls`, stating exactly when each must be used and the one exception (standard objects never carry a namespace).
**Action 2 — closeout sweep**: cross-referenced every non-test class touching `.getSObjectType()`/`.getDescribe().getName()` (40 files) against everything already covered, isolating 9 never-audited files: `genericSendEmail.cls`, `TA_ManageCustomerContacts.cls`, `TA_ContentDocLink_GetDocCount.cls`, `PolicyParticipationReCalculation.cls`, `TA_ContentDocument_FileCountUpdate.cls`, `TriggerBase.cls`, `SB_MaskDataBatch.cls`, `ContentDocumentLinkHandler.cls`, `recordShareUtility.cls`.
**Two more genuine bugs**: `TriggerBase.cls`'s bypass registry (`bypass`/`clearBypass`/`isBypassed`) added/checked a bare caller-supplied string against a `Set<String>`, while `shouldRun()` checked the same set against `this.sObjectName` (namespaced once packaged) — every existing caller uses a bare literal, so post-install the bypass silently never takes effect (no exception, trigger just runs). Fixed with a `canonicalSObjectName(String)` helper resolving through `Utils.resolveSObjectType(...).getDescribe().getName()`. `SB_MaskDataBatch.cls` — a second, missed half of #46's masking bug: `execute()` used the *unresolved* bare field name for `.fields.getMap().get(fieldName)`, on the consuming side of the same config values #46 fixed on the producing side; fixed by resolving once per record via `Utils.resolveFieldApiName`.
**Confirmed safe** in the other 7: `genericSendEmail`, `TA_ContentDocLink_GetDocCount`, `PolicyParticipationReCalculation`, `TA_ContentDocument_FileCountUpdate`, `ContentDocumentLinkHandler` all compare `Schema.SObjectType` tokens directly (always safe, different mechanism); `TA_ManageCustomerContacts` only interpolates into a log message; `recordShareUtility` compares only standard Share-object field names (never namespaced).
**Flagged, not fixed**: `TriggerActionFlowBypass`/`TriggerActionFlowClearBypass`/`TriggerActionFlowIsBypassed` feed Flow-configured names into the now-fixed `TriggerBase` methods — automatically covered by the fix, but worth a spot-check next time those are touched.
**Lesson**: a bug-class fix isn't finished until it's codified where developers will see it *and* swept against the full file inventory, cross-checked against what's already covered. `TriggerBase.cls` is core plumbing called by dozens of classes/nearly every test — far more blast radius than any individual controller bug.

### 48. A fifth boundary, the mirror of #44: LWC→Apex, failing as a hard DML error instead of a silent null

**What prompted this**: a live error — `internalContactManager`'s "save RM assignments" threw `DmlExecutionException: ...bad field names...: Service_RM__c, Sales_RM__c, Claim_RM__c` post-install. Traced to `InternalContactController.updateInternalContactRMFields`'s typed `List<Internal_Contact__c>` `@AuraEnabled` parameter.
**Why distinct from #44**: #44 is Apex→LWC (a return value's namespaced JSON keys don't match bare LWC expectations — fails silently). This is the opposite direction: an LWC hand-builds a plain JS object with literal bare-`__c` keys and sends it to a typed `@AuraEnabled` parameter (or explicit `JSON.deserialize(json, SomeSObject.class)`). That deserialization path requires an **exact, namespace-qualified match with zero tolerance** — no `Utils` equivalent exists inside it — so it throws `INVALID_FIELD_FOR_INSERT_UPDATE` outright: loud and immediate, but total (whole DML fails) rather than partial.
**The fix, a new reusable `Utils.cls` helper**:
```apex
public static SObject buildSObjectFromMap(Schema.SObjectType objType, Map<String, Object> data) {
    SObject record = objType.newSObject();
    if (data == null) { return record; }
    Map<String, Schema.SObjectField> fieldsMap = objType.getDescribe().fields.getMap();
    for (String rawFieldName : data.keySet()) {
        String resolvedFieldName = resolveFieldApiName(fieldsMap, rawFieldName);
        if (resolvedFieldName != null) { record.put(resolvedFieldName, data.get(rawFieldName)); }
    }
    return record;
}
```
Pattern: deserialize incoming JSON via `JSON.deserializeUntyped(...)` into a generic Map/List, then build the SObject through this helper.
**Fixed in 4 places**: `InternalContactController.updateInternalContactRMFields` (param changed to `String recordsJson`; `internalContactManager.js` call site sends `JSON.stringify(records)`); `RequestForQuoteSendController.saveRequestForQuoteWithResponses` (both `JSON.deserialize` calls replaced; called from `requestForQuoteSendLayout.js`); `sendRFQController.saveQuoteResponses` (same, from `sendRFQLayout.js`); `EndorsementController.CreateEndorsementRecord` (fixed proactively — currently unreferenced by any LWC, a latent risk fixed before it became live).
**Confirmed safe**: `customerContactManager.js`/`CustomerContactController.createCustomerContact` (already `String`-typed, manual parsing); `createEndorsement.js`/`EndorsementController.saveEndorsement` (camelCase DTO, not raw SObject); `scheduleModal.js`/`SchedulerService.saveScheduleJob` (already `JSON.deserializeUntyped` + manual assignment); `subPolicyView.js`/`subPolicySetup.js` (camelCase DTOs).
**Lesson**: two symmetric boundary bugs (#44 and this one) bracket the same seam from opposite directions. Not every instance of a bug family looks like the reported one — the sweep found the same root cause hiding behind an explicit `JSON.deserialize(..., SomeType.class)` inside a `String`-typed parameter, which a "typed SObject parameter" search alone would have missed. Search for the underlying mechanism, not the exact syntactic shape.

### 49. #46's own fix caused a performance regression: `Utils.isSameObjectType` inside a per-field loop blew the CPU limit

**Symptom**: `EndorsementControllerTest` failing with `System.LimitException: Apex CPU time limit exceeded`, traced through `cloneActionHandler.cloneFromConfig` → `runCloneBySpecs` → `resolveChildSpecs` → `discoverChildRelationships` → `detectManyToMany` → `Utils.isSameObjectType` → `Utils.resolveSObjectType`.
**Root cause**: `Utils.resolveSObjectType(String)` calls `Schema.getGlobalDescribe()` (a full org-schema rebuild) on **every invocation**. `detectManyToMany` (fixed correctly in #45) loops over every field of every child object calling `isSameObjectType` (2 internal `resolveSObjectType` calls each) for every `REFERENCE` field — hundreds of full-schema rebuilds per transaction for a parent with many child relationships. Invisible while the old raw `!=` comparison was in place (cheap but wrong).
**Fix**: cache `Schema.getGlobalDescribe()` in a private static variable in `Utils.cls`, computed once per transaction (org schema can't change mid-transaction):
```apex
private static Map<String, Schema.SObjectType> globalDescribeCache;
private static Map<String, Schema.SObjectType> cachedGlobalDescribe() {
    if (globalDescribeCache == null) { globalDescribeCache = Schema.getGlobalDescribe(); }
    return globalDescribeCache;
}
```
`resolveSObjectType` now calls this instead of `Schema.getGlobalDescribe()` directly — every caller across #42/#45/#46/#47/#48 benefits with no call-site changes.
**Lesson**: a namespace-tolerant helper correct in isolation can still be a performance regression once called from inside a loop that used to be cheap — check what a replacement helper does internally, not just whether it returns the right answer, especially when it's going inside a loop.

### 50. A sixth (and seventh) boundary: base Lightning component attributes need the resolved schema token, not a string

**What prompted this**: `lightning-record-picker` with `object-api-name="Broker_Office_Location__c"` threw "This field can't load because of a configuration problem" post-install — a different seam from every prior boundary bug (Apex code/Apex↔LWC payloads); this is a platform base component's HTML template attribute.
**Why distinct**: Apex resolves bare same-namespace names automatically (#42), and a `@salesforce/schema` import in an LWC module gets equivalent treatment — but a plain string handed to `object-api-name`/`field-name` calls the platform's UI API layer at runtime with exactly the string given, no tolerance. Once packaged it needs the fully-qualified name; a bare literal fails with an inline component config error, not a JS exception — easy to miss in review since nothing throws.
**The fix — the documented Salesforce pattern, not a custom helper**: import via `@salesforce/schema` and bind `.objectApiName` (or the token itself for `field-name`):
```js
import BROKER_OFFICE_LOCATION_OBJECT from '@salesforce/schema/Broker_Office_Location__c';
get locationObjectApiName() { return BROKER_OFFICE_LOCATION_OBJECT.objectApiName; }
```
```html
<lightning-record-picker object-api-name={locationObjectApiName} ...>
```
**Fixed across every `lightning-record-picker`/`lightning-record-edit-form`/`lightning-input-field`/`lightning-output-field`/`lightning-record-form` in `force-app/managed/main/default/lwc/`**: `object-api-name` in `addNewCDAccount` (originally reported), `createEndorsement`, `createInitialNeedAssessment`, `engagePolicyTimeline`/`policyTimeline`, `policyPaymentForm`, `subPolicySetup` (5 imports total across these). `rfqCoveragePanel` — both `object-api-name` (with a fallback, below) and all 18 `lightning-input-field` `field-name` bindings (rebuilt `FIELD_CONFIG` to hold resolved schema tokens directly; also fixed a template-literal `key` generator that would have produced `"[object Object]_0"` once tokens replaced strings). `rfqCoveragePanel` also exposes `@api objectApiName` for 3 Lightning page target types — the platform auto-injects it on a Record Page but the template hardcoded a string instead, and the other 2 target types never populate it — fixed with a fallback getter (platform-provided prop, else the resolved schema import).
**Confirmed safe**: `object-api-name="Account"`/`"Contact"` (standard, never namespaced) left untouched; ~12 files (`engage_billing`, `engage_claims`, `engage_cdAccountView`, `engage_createEndorsement`, `engage_endorsements`, `engage_fileClaim`, `engage_intimatePayment`, `engage_portfolio`, `engage_servicerequests`, `policyCreation`, `sendRFQLayout`) pass a bare object string to this codebase's own custom wrapper components (`c-engage-lookup`, `c-engage-data-table`), not a base Lightning component — traced into both wrappers and confirmed the value only reaches already-tolerant Apex/JS, never a base component's schema-bound attribute.
**Lesson**: the first bug in this log where the fix is "use the platform's own resolution" rather than a project helper, since `@salesforce/schema` already does what `Utils` does, at the LWC-module level. Ten distinct mechanisms now share one root cause: any place a custom name crosses from namespace-aware code into a generic runtime layer taking the string literally needs deliberate handling.

### 51. Apex tests needing FLS/CRUD enforcement can't depend on an org-assigned Permission Set

**What prompted this**: 3 unrelated failures — `InitialNeedAssessmentControllerTest.testCreateInitialNeedAssessment` (`AuraHandledException` from `insert as user`), `PolicyCreationControllerTest.testGetProductsWithClass`/`testSearchBusinessLocations` (`QueryException` from `WITH SECURITY_ENFORCED`). Confirmed via `git log` unrelated to #42–#50.
**Root cause**: both enforcement patterns are correct and shouldn't be weakened — the permission set XML (`IB_Admin.permissionset-meta.xml`) already grants full access. The real problem is structural: Permission Sets are a deliberate exclusion from the package (#32, Part IV), living in `force-app/unmanaged/`, deployed as a separate manual step. 2GP Apex test validation runs in an ephemeral scratch org containing **only** `force-app/managed/main/default/` — no permission set from `unmanaged/` is ever present there.
**Fix**: `TestDataSetup.createUserWithFullAccessTo(List<String> objectApiNames)` — builds access at runtime: creates a test user + a `PermissionSet`, dynamically inserts `ObjectPermissions`/`FieldPermissions` for every field of each requested object (via `Utils.resolveSObjectType`), assigns via `PermissionSetAssignment`, returns the user for `System.runAs(...)`. `FieldPermissions` inserted with `Database.insert(fieldPerms, false)` since system/formula fields reject explicit FLS grants. Applied to all 3 tests, each wrapping only the controller call under test in `System.runAs(grantedUser)`.
**Lesson**: shipping Permission Sets separately (the #25–#41 strategy) has a direct testing consequence — any test exercising FLS/CRUD-enforced code must build its own runtime grant, because 2GP validation is exactly the environment guaranteed *not* to have org-side permission sets. Mirrors `TestDataSetup.insertClaims`/`updateClaims`'s existing `AccessLevel.SYSTEM_MODE` workaround — that one bypassed FLS because the DML was just prerequisite data; this one grants FLS properly because the DML/query is the thing under test.

### 52. Two more failures: a missing `disableFlows()` call, and #51's fix needed to move into `@TestSetup`

**What prompted this**: `AssignLeadControllerTest.setup()` failing 7× with `INVALID_FIELD_FOR_INSERT_UPDATE: [InsureBridge__Email__c]` on a plain Contact insert, plus #51's 2 `PolicyCreationControllerTest` failures still occurring despite the fix being in place.
**`AssignLeadControllerTest` root cause**: `Contact_Preventing_duplicate_contact_creation_by_Email.flow-meta.xml` copies `Email`→`Email__c` unless `Disable_Flows__c`/`AllowDuplicateContactEmails__c` is true; in a fresh scratch org neither Custom Setting has a record, so the flow always runs. Every other test class calls `TestDataSetup.disableFlows()` for this reason; this new test class (added for the new `AssignLeadController`) never picked up the convention. Ruled out as a metadata/namespace bug first (confirmed no Workflow/Trigger Action/Process targets `Contact.Email__c`). Fixed by adding `TestDataSetup.disableFlows();` as the first line of `setup()`.
**Why #51's fix didn't take effect**: `createUserWithFullAccessTo(...)` was called *inline inside the `@IsTest` method*, right before `System.runAs`. `WITH SECURITY_ENFORCED`/`as user` read a permission snapshot that doesn't reliably refresh for same-transaction grants (the same limitation already documented on `TestDataSetup.insertClaims`/`updateClaims`). `@TestSetup` commits in its own transaction before each `@IsTest` method starts. Fixed by moving every `createUserWithFullAccessTo(...)` call into `@TestSetup`, adding an overload `createUserWithFullAccessTo(objectApiNames, emailStr)` so the `@IsTest` method can re-query the granted user by a distinguishing email (static state doesn't carry over, only committed data).
**Lesson**: the second time this exact same-transaction FLS-snapshot limitation has bitten this codebase. Any runtime permission grant needed by `WITH SECURITY_ENFORCED`/`as user`/`stripInaccessible` must happen in `@TestSetup`, never inline in `@IsTest`, regardless of position relative to `Test.startTest()`.

### 53. #52's own fix needed a fix: `disableFlows()` too blunt, plus a `PermissionSet.Label` collision

**What prompted this**: 3 new problems after #52's fix — `testAccountMissingFlaggedWhenCompanyBlank` failing ("Flows should not be disabled by default", expected false got true); `testContextReturnsLeadDetailsAndUserOptions` failing (`accountMissing` unexpectedly null); a fresh `WITH SECURITY_ENFORCED` failure on `AssignLeadController.assignLead`'s `Lead__c` query (same shape as #51/#52, just not yet applied here). Separately, `PolicyCreationControllerTest.setup` started failing with `DUPLICATE_MASTER_LABEL`.
**Why `disableFlows()` was wrong here**: `Disable_Flows__c` is a Custom Setting whose value, once set in `@TestSetup`, persists as committed data for *every* `@IsTest` method in the class — not just during setup. #52's call to `disableFlows()` broke both tests above (one asserts the *default*, non-disabled state; the other's `getLeadContext` checks the same flag first and returns early with defaults when true). Fix: use the flow's *narrower* independent skip condition (`FeatureControls__c.AllowDuplicateContactEmails__c`) instead of the blunt global flag.
**`assignLead`'s FLS failure**: the same #51/#52 pattern, not caught in the first pass since only `getLeadContext` had been reported. Fixed the same way, but with a wrinkle: 2 of this class's tests assert on `UserInfo.getUserId()` as the resulting record owner — a separate `runAs` user would answer a different identity question than the assertion checks. Fixed by adding `TestDataSetup.grantCurrentUserFullAccessTo(List<String>)` — same permission-set logic (extracted into a shared `buildFullAccessPermissionSet` helper), assigned directly to `UserInfo.getUserId()`, no `runAs` needed.
**`DUPLICATE_MASTER_LABEL`**: `createUserWithFullAccessTo`'s `PermissionSet` used a randomized `Name` but a hardcoded literal `Label` ('Test FLS Grant') — `Label` must be org-unique too, and the first run creating more than one grant collided. Fixed by deriving both `Name` and `Label` from the same random suffix.
**Lesson**: two lessons about not reaching for the broadest tool. (1) When an automation has multiple skip conditions, use the narrowest one that satisfies the requirement. (2) A "grant access" helper must ask which user the test's assertions actually check before reaching for `runAs`.

### 54. An eighth namespace boundary, found twice in one afternoon: Apex invocable actions in a Flow's `actionCalls`

**What prompted this**: `INA_Process_Conclude.flow-meta.xml: Add_Customer_Contacts (Action) - We can't find the genericDynamicApexInvoker action.` The Flow lives in `force-app/unmanaged/`; `genericDynamicApexInvoker` (a `global class` with `@InvocableMethod`) lives in `force-app/managed/`. Same Rule #1 (unmanaged metadata needs the explicit prefix), applied to a new component type: `actionCalls` with `<actionType>apex</actionType>` needs its `<actionName>` *and* `<nameSegment>` namespace-qualified — same rule already established for subflow `flowName` and LWC `componentName` (#41).
**Fixed in 2 files, both from real deploy errors**: `INA_Process_Conclude.flow-meta.xml` — 2 `actionCalls` (4 tags), one already "fixed" with the wrong casing (`Insurebridge__`, the exact trap from #43), corrected to `InsureBridge__`. `Policy_After_Created_Update_Flow.flow-meta.xml` — 3 more, all previously bare: `genericDynamicApexInvoker`, `GetAvailableDocumentTypeListInvocable`, `GSTConfigUtils` (confirmed `global`/`@InvocableMethod` before fixing — not every Apex class is a valid Flow action target).
**Confirmed correctly left bare**: the same flow's `NewTask` Global Quick Action (`<actionType>quickAction</actionType>`, no object qualifier) — Global Actions are org-level primitives, never namespaced, even when the package retrieves/customizes them under its own `quickActions/` folder.
**Lesson, and why it earned its own `CLAUDE.md` checklist**: the identical gap existed in 2 different unmanaged Flows, found via 2 separate deploy-error round-trips instead of one sweep. A rule stated broadly in the abstract doesn't stop someone missing a specific instance — a per-component-type checklist (object/field, Apex class, Apex invocable action, Flow, LWC/Aura bundle, Global vs. object-specific Quick Action) is what actually prevents a third/fourth instance.

### 55. A ninth boundary: `getRecord`'s response side, keyed by the real (namespaced) field name

**What prompted this**: a production error in `updatedPolicyVersionPrompt.js` — `Cannot read properties of undefined (reading 'value')` — traced to hardcoded `data.fields.Updated_Policy__c.value`/`data.fields.Is_Endrosement__c.value`.
**Why distinct from #50 (rule #6)**: rule #6 is the *template attribute* needing a resolved token. This is a different mechanism: `getRecord`'s `fields` **request** array, built correctly from schema imports, resolves the namespace fine when *requesting* — the bug is entirely on the **read** side. The response's `data.fields` is keyed by the real runtime name; `updatedPolicyVersionPrompt.js`'s `FIELDS` array was built correctly, but the response was read back with hardcoded literals instead of `data.fields[TOKEN.fieldApiName]`. `Name` (standard) happened to work via the same hardcoded pattern, hiding the other two until installed.
**Immediate fix**: both fields switched to `data.fields[TOKEN.fieldApiName].value`.
**Proactive sweep**: 18 files calling `getRecord`/`getFieldValue`/`getFieldValues`, plus checking for the deeper variant (the request array itself built from hand-written strings).
**Two more confirmed and fixed**: `policyPaymentForm.js` — the deeper variant: its entire field-fetching layer (`POLICY_RECORD_FIELDS`, `INSTALLMENT_RECORD_FIELDS`) was hand-written dotted-path strings including relationship traversals and a `_toPolicyField()` helper hardcoding `Policy__c.` for a dynamic `@api accountIdField`/`amountFieldName` override (even the *default value* was the same bare string — the primary path, not an edge case). Rewrote everything through schema imports/`.fieldApiName`/`.objectApiName`, including `additionalFields` (rule #6) and a bare object-name comparison (rule #4's client-side equivalent). One residual gap documented in-code: a parent-supplied runtime override of `accountIdField`/`amountFieldName` still can't resolve through a static import. `genericRefreshPageUtils.js` — a generic component where `@api fieldsToTrack` is free-text and runtime-configured, so no static import can cover it; fixed by calling `getObjectInfo` first and resolving each raw field segment against the real describe (bare/namespaced/case-insensitive) — a client-side `Utils.resolveFieldApiName` equivalent.
**Confirmed safe**: `subPolicyView.js`, `confirmPaymentAdjustment.js` (already token-based); `genericCsvImporter.js` (only reads standard `Name`); `cdAccountDashboard.js`, `genericPathComponent.js` (dynamic reference built and read the same way, internally consistent); 9 further files with no `getRecord` field-name exposure at all.
**Lesson**: the second time a correctly-stated abstract rule (#6) didn't stop a mechanically distinct bug on the same seam. `getRecord`'s request side and response side are two separate opportunities to get this wrong — fixing one doesn't imply the other was checked.

### 56. `LineItemController`/`lineItemManager.js` had two of its own conventions disagreeing with each other

**What prompted this**: a live DML error — `INVALID_FIELD_FOR_INSERT_UPDATE: [InsureBridge__Policy_Premium_Key__c]` from `LineItemController.saveRecords`, plus a request to make the LWC's design-time `fieldApiNames` property namespace-tolerant.
**Root cause, three layers**: (1) `FieldDescriptor.apiName`/`relationshipName`/`referenceTo` were left namespaced (`dfr.getName()`, unstripped), while the sibling `getChildRecords` method already strips via `Utils.stripNamespaceFromRecords` — two methods feeding the same LWC disagreed on convention, silently producing blank cells (#44's "no error at all" profile, in a component neither #48 nor #55's sweeps covered). (2) `saveRecords`'s DML loop used the raw incoming JSON key directly in `sobj.put(key, ...)`, only using the *lowercased* key for the `containsKey` guard, never the resolved name for the actual `.put()` — same for the relationship-stamping put. (3) `lineItemManager.js`'s `fieldApiNames` matching (`configuredFields.filter(f => fieldMap[f.toLowerCase()])`) silently dropped any bare-configured field once `fieldMap` held only namespaced keys — no error, field just vanished.
**The fix, all three layers made mutually consistent**: `FieldDescriptor`'s constructor now strips via a newly-widened `Utils.stripNamespacePrefix` (previously `private`, now `public` — the single-string counterpart to `stripNamespaceFromRecord`). `saveRecords` resolves every incoming key through `Utils.resolveFieldApiName` and uses the *resolved* name for both the check and the `.put()`. `lineItemManager.js` gained `resolveConfiguredFieldApiName(rawName, fieldMap)` — a client-side mirror of `Utils.resolveFieldApiName` (exact/namespaced/stripped/case-insensitive) — used to build `_fieldApiNameList`.
**Lesson**: a component can pass every individual boundary-rule check and still break if two of its own methods "fix" the same boundary in different directions — check that all of a component's methods agree on which side the bare/namespaced convention lives, not just that each resolves correctly in isolation.

### 57. A tenth boundary: `/lightning/cmp/` component URLs — `c__` only resolves in the default/no-namespace context

**What prompted this**: a browser error — `No COMPONENT named markup://c:genericSendEmailHost found`. The Aura component exists only in `force-app/managed/`, but every reference used `/lightning/cmp/c__genericSendEmailHost?c__recordId=...&c__featureName=...`.
**Why distinct from #41/#54**: those are metadata-relationship resolutions; this is a *runtime browser navigation URL* parsed literally by the Lightning Component Loader with no namespace-aware resolution. `c__` means the default/no-namespace context; a namespaced component needs `<Namespace>__ComponentName`, and critically **every query-parameter key needs the same prefix** too (`c__recordId`→`InsureBridge__recordId`).
**Fixed in 18 places, two mechanisms**: 14 `WebLink` files (buttons on `Claim__c`, `Policy__c`, `Request_For_Quote__c`, `Settlement__c`, `PremiumTypePolParticipation__c`) using `c__genericSendEmailHost`/`c__cloneActionWrapper` URLs, all fixed to `InsureBridge__`; 4 formula fields (`Claim_Approval__c.Notify_Approval_to_Insured__c`, `Service_Provider__c.Notify__c`/`Notify_to_Claimant__c`, `Settlement__c.Notify_Settlement_to_Insurer__c`) building the identical URL via `HYPERLINK()` — same fix; one code comment updated for consistency.
**Confirmed correctly left alone**: `force__dynamicRelatedListViewAll?force__cmpId=...` on an Account Web Link — `force` is a genuine Salesforce platform namespace, unrelated to this package's boundary.
**Lesson**: this class is easy to miss since a `WebLink` `<url>`/formula `HYPERLINK()` string doesn't *look* like an object/field/component reference. The tell is always the same: a runtime resolution mechanism (here, the Component Loader) with its own namespace rule, independent of the file type holding the string. Audit every `/lightning/cmp/` URL — WebLinks, `HYPERLINK()`s, custom buttons, even `window.open()` calls.

### 58. Made the LWC-side tolerant resolver reusable, then swept every other component with a design-time field-name property

**What prompted this**: confirming #56's fix was correct (a report of it "not working" matched pre-fix behavior against a not-yet-redeployed org, not a real gap), then a request to generalize: any LWC value sourced from external config should try both namespaced and bare forms.
**What changed**: extracted the tolerant-resolution logic (previously duplicated in `lineItemManager.js` and `genericRefreshPageUtils.js`) into `resolveNamespacedKey(rawName, lookupMap)`, exported from the shared `c/utils` module (`force-app/managed/main/default/lwc/utils/utils.js`) — the client-side counterpart to `Utils.resolveFieldApiName`, same matching order. Both components refactored to call the shared helper.
**Proactive sweep**: 11 files with a design-time `@api` property named like `*fieldApiName*`/`*objectApiName*`, checking for unresolved lookups into Apex/`getObjectInfo` data.
**Lesson**: centralizing a fix as a named, importable helper is what makes "review all LWCs for this pattern" tractable — every future fix becomes "import and route through it" instead of re-deriving the logic per file, which is exactly how #55/#56's near-duplicate copies happened.

### 59. Three more instances of #56's exact bug shape, found by an agent investigating a different question

**What prompted this**: while dispatching the #58 sweep, a differently-scoped Apex-focused agent reported back 3 genuine instances of #56's shape: a caller-supplied field-name variable used directly in `SObject.put()`/`.get()` without resolution — empirically proven unsafe by #56's live DML failure, unlike a compile-time literal.
**Fixed**: `InternalContactController.getProductId` — `result.get(productFieldApiName)` used the raw name (the SOQL above it was already safe as dynamic text); resolved via `Utils.resolveFieldApiName` before both query and read. `InternalContactController.assignInternalContactsToRecord` — 2 raw `.put()`s and a raw `containsKey` upsert-key check, all routed through the resolver. `CustomerContactController.getPicklistValues` — had a manual fallback (`fieldMap.get('InsureBridge__' + fieldApiName)`) that hardcoded the namespace literal and would double-prefix an already-namespaced input; replaced with `Utils.resolveFieldApiName`.
**Also cleaned up (not a bug)**: `getSObjectRecords.cls`'s dead dedup guard `!fieldMap.containsKey('InsureBridge__'+fieldDesc.getName())` could never match anything (checking for a double-prefixed key against an already-namespaced name) — removed.
**Lesson**: an agent given a narrower/differently-worded task can still surface directly actionable findings for standing bug classes, since the underlying pattern-recognition (resolved vs. raw field name in `.put()`/`.get()`) is the same regardless of framing. Read what comes back before dismissing it as off-topic.

### 60. The retried #58 LWC sweep found 5 more, including one with real security implications

**What prompted this**: a re-launched LWC audit (the first attempt returned a placeholder instead of doing the work) found 5 confirmed bugs, same root shape as #55/#56/#58, reached through new mechanisms.
**New Apex helper needed**: `Utils.resolveObjectAndFieldApiName(String objectApiName, String fieldApiName)` — an `@AuraEnabled(cacheable=true)` method returning resolved real names as a `Map<String,String>`, for cases with a fully admin-typed object *and* field name that LWC alone can't resolve (no client-side `Schema.getGlobalDescribe()` equivalent).
**Fixed, 5 instances**: `genericPathComponent.js` — admin-configured `objectName`/`fieldName` concatenated into a literal `getRecord` fields array; fixed via the new Apex helper, called once in `connectedCallback`; also fixed `getCurrentStage()` reading `data[0][this.fieldName]` from an already-bare-keyed Apex response — needed the *bare* form (same disagreeing-conventions shape as #56). `cdAccountDashboard.js` — identical unsafe pattern, compounded by a pre-existing casing typo (`this.AccountFieldAPIName` vs. declared `accountFieldAPIName`) that made the whole feature dead code, hiding the namespace bug; both fixed. `policyTermsConditionLayout.js` — `objectApiName` here is **platform-injected** (dual `lightning__RecordPage` targets on `Policy__c`/`Request_For_Quote__c`), not admin-typed; `isRFQContext` did a bare `=== 'Request_For_Quote__c'` compare against a namespaced value, meaning **every RFQ record page silently ran the Policy code path** — fixed by stripping the namespace before comparing. `EngageLookupController.cls` (backing `engageLookup.js`) — `isValidFieldPath`/`findFieldByRelationshipName` and the value-reading `getFieldValue` helper all used raw `.get()`/`.equalsIgnoreCase()` against real describe keys/relationship names; routed through resolvers. **More serious finding in the same file**: `ACCOUNT_FILTER_BY_OBJECT` — a hardcoded bare-keyed map gating a mandatory Account-scoping security filter (documented in the class header as preventing unscoped enumeration) — keyed by `objectApiName.toLowerCase()` (namespaced once packaged, never matching). Traced carefully: the mismatch also breaks the allowlist check one step earlier, which rejects the call *before* the security filter is reached — so this fails **closed** (usability bug) not **open** (data leak). Fixed via a `resolveAccountFilterKey` helper used by both checks, preserving fail-closed behavior for anything genuinely not allow-listed. `genericCsvImporter.js`/`CsvImportController.cls` — `skipMandatoryFields` (admin-configured bare names) compared via raw `Set.has()` against real namespaced `apiName`s — an exemption would silently never match, producing spurious "missing required field" warnings; fixed client-side via `resolveNamespacedKey`. Also fixed `bulkInsert`'s existence-check gate (`fieldMap.containsKey(lower)`, raw) to use `Utils.resolveFieldApiName` — the actual `.put()` was already using the resolved name.
**Lesson**: two things. First, a sub-agent can return an unhelpful placeholder instead of real findings — verify substance before treating "completed" as done; retry with an explicit "do this yourself" instruction. Second, when a namespace mismatch gates a security-relevant check, trace *all* the surrounding checks together before concluding fail-open vs. fail-closed — assuming the worse case without checking would have been inaccurate, if conservative.

### 61. #55's own fix didn't compile: `@salesforce/schema` cannot import a relationship pseudo-field

**Symptom**: a deploy-time compiler error — `Invalid reference Policy__c.Product__r of type sobjectField in file policyPaymentForm.js`, plus 4 more (one per spanning relationship #55's fix introduced: `Insurer__r`, `Customer_Name__r`, `Installment_Schedule__c`'s `Policy__r`/`Endorsement__r`).
**Root cause**: `@salesforce/schema/Object__c.Field__c` imports a real field's token — a relationship name (`__r`) is not a field, it's a pseudo-property for traversal, and the LWC compiler rejects importing one directly. #55's fix assumed spanning-relationship imports worked like plain field imports without verifying against an actual build.
**Fix**: import the underlying lookup field instead (`Policy__c.Insurer__c`, `Policy__c.Product__c`, etc.) and derive the relationship name in JS via `toRelationshipName(fieldApiName)` (`fieldApiName.replace(/__c$/i, '__r')` — the standard Salesforce convention). Every downstream `data.fields[...]` read and `POLICY_RECORD_FIELDS`/`INSTALLMENT_RECORD_FIELDS` entry updated accordingly. Swept the codebase for the same import shape — confirmed this was the only file with it.
**Lesson**: a fix that "looks right" by an established pattern can still not compile if applied to something structurally different (plain field vs. spanning relationship) from what the pattern was proven against. Verify by an actual deploy/build when extending a fix to a new shape, not just code review — this only surfaces at compile time.

### 62. An eleventh boundary: `global` vs `public` on a wrapper/DTO type, not a namespace *prefix* mismatch at all

**What prompted this**: Salesforce support's explanation of a live `BAD_REQUEST` — `ApexService.getType() return null with currentNamespace: null, namespace: InsureBridge.CDAccountFundingController, name: TransactionRequest`. The Aura/LWC service that executes every `@AuraEnabled` call (`aura://ApexActionController`, shared by both frameworks despite the Aura-flavored name) has to reflectively resolve the Apex type of every custom param/return type before your method body runs. For a managed package, that resolution only succeeds if the type is `global`; `public` is invisible once the caller is outside the namespace, so the whole call dies with `BAD_REQUEST` before it starts.
**Why this is a different axis from Rules #1–#10**: those are all about a namespace *prefix* being missing/mismatched on an object, field, or component name. This is about class-level *visibility* on the wrapper type itself — same-namespace Apex and Anonymous Apex never see it at all (direct method call, no serialization layer); only the client-facing action service hits it.
**Swept every `global` class in the package for `@AuraEnabled` methods returning/taking a `public` inner type; fixed all**: `CDAccountFundingController` (`TransactionRequest`, `TransactionResult`, `PaymentCreditWrapper`, `AllocationDetail`, `ReversalAvailabilityResult`, `InstallmentOption`, `PolicyPaymentDefaults`, `PaymentAdjustmentContext`, `PolicyCancellationContext`, `AdjustmentCreditWrapper`, `ConfirmAdjustmentRequest`, `AdjustmentAllocation` — every wrapper in the file), `initiateRFQActionController` (`OpportunityWrapper`, `FileWrapper`, `ContactWrapper`, `CreateRFQRequest`), `PolicyCreationController` (`InitData`, `ProductOption`, `PolicyCreateRequest`), `EngageLoginController` (`ResetPasswordResult`), `engageNotificationController` (`NotificationItem`). All changed `public` → `global`.
**Likely explains a previously-unresolved investigation**: `initiateRFQActionController.createRFQ`'s live 500 error, where Anonymous Apex reproduction of the identical business logic succeeded perfectly — because Anonymous Apex bypasses the action service entirely, so it never saw the failure a real LWC call would hit.
**Lesson**: a generic "internal server error" from an `@AuraEnabled` call can be this exact platform-level type-resolution failure, indistinguishable client-side from a genuine unhandled business-logic exception. The server debug log is the only place the real `ApexService.getType()` reason shows up.

### 63. `global` alone isn't always enough for a nested class — a still-open platform limitation

**What prompted this**: reviewing a Salesforce StackExchange thread ("Why the AuraEnabled method throws an internal error when a namespace is enabled") and its linked, still-open IdeaExchange request ("Fix nested classes for AuraEnabled methods with namespace"), while validating #62's fix.
**The claim**: a nested/inner class used as an `@AuraEnabled` param/return type can apparently still fail the same cross-namespace resolution even after being declared `global`, unless the outer class *also* declares a property of that inner type somewhere — the platform needs that extra registration point to notice the type exists at all. One documented workaround: `JSON.deserialize`/serialize the payload as a string instead of a typed param (already the pattern `PolicyCreationController.createPolicy`/`CreateClaimController.createClaim` independently landed on, for a different reason — Lightning's automatic complex-object binding silently arriving with every field null). The more invasive fallback: extract the wrapper out of the outer class into its own top-level `global` class entirely.
**Defensive fix applied to all five #62 classes**: one unused `@AuraEnabled public <WrapperType> typeRegistration_<WrapperType>;` property per wrapper, declared once near the top of each outer class. Never read anywhere — its only job is forcing the platform to register the type's metadata.
**Not yet independently verified** against a real subscriber-org failure recurrence — cheap insurance, not a confirmed fix for a reproduced case. If `ApexService.getType()` ever recurs on one of these five classes despite `global` + this property, extracting the wrapper to a top-level class is the next thing to try.
**Lesson**: a StackExchange/community thread plus an official IdeaExchange entry is a legitimate signal that a platform behavior is a genuine, acknowledged bug rather than a misunderstanding of the documented contract — worth checking before assuming a fix that matches Salesforce's own documented cause is automatically complete.

### 64. `getSObjectRecords.buildSOQLQuery` threw "duplicate field selected" when config supplied a field both bare and namespaced

**What prompted this**: a live error — `System.QueryException: duplicate field selected: InsureBridge__Email__c` — traced to `IntegrationUtils.getQry`, which builds dynamic SOQL from integration/mapping config data (`Map<String,Object>` field values) via `getSObjectRecords.buildSOQLQuery`.
**Root cause**: the config can legitimately supply the same logical field twice — once bare (`Email__c`, from before the package was namespaced) and once namespaced (`InsureBridge__Email__c`, added later as an override) — and `buildSOQLQuery` added both as distinct `Set<String>` entries. Since this class is same-namespace Apex, dynamic SOQL *text* auto-resolves a bare custom-field literal to the real namespaced field (Rule #2) — so both entries resolve to the identical column, and the platform (correctly) rejects selecting the same column twice.
**Fix**: every field token is normalized through `Utils.stripNamespacePrefix` before being added to the `Set`, so both forms collapse to one entry.
**Lesson**: Rule #2's "bare literals auto-resolve" guarantee is exactly what turns a config data-quality issue (the same field listed twice, in two conventions) into a hard runtime failure — same-namespace auto-resolution isn't only a namespace-boundary concern, it also removes the platform's own ability to tell two textually-different field tokens apart once they resolve to the same column.

### 65. `Utils.resolveFieldApiName` itself had a casing bug — a second, independent duplicate-field-selected failure

**What prompted this**: the exact same `duplicate field selected: InsureBridge__Policy__c` symptom recurring in `cloneActionHandler.cloneOneToManyChildren`, despite that method already using the `Utils.resolveFieldApiName`-based dedup pattern established for #64.
**Root cause**: `resolveFieldApiName` returned the raw **lowercase** `fields.getMap()` key (`insurebridge__policy__c`) instead of the field's real, correctly-cased API name. `getCloneableFields` (a sibling method, populated via `dfr.getName()`) stores the properly-cased form (`InsureBridge__Policy__c`) for the same field. `cloneOneToManyChildren`'s `childFields.contains(resolvedParentRefApi)` dedup check is a case-*sensitive* `List.contains()` — with the two methods returning different casings for the identical real field, the check silently failed and the same column was added to the field list twice.
**Fix**: `resolveFieldApiName` now returns `fields.get(matchedKey).getDescribe().getName()` at all three return points, instead of the lowercase map key directly. Checked all ~30 existing call sites across the codebase for a casing dependency before changing it: none exist — `SObject.get()`/`.put()` are case-insensitive in Apex, and the few callers (`EndorsementController`) that specifically need lowercase already call `.toLowerCase()` on the result themselves, so they're unaffected by the fix.
**Lesson**: a shared "resolve the real name" helper has to return the *real* name, not an internal implementation detail (a Schema API's lowercase map key) that happens to work for callers that don't compare it against another source. The bug was invisible until two different callers' outputs for the same field were compared directly.

### 66. `getRecordsDynamically`'s own separate duplicate-field-selected bug, same symptom, different mechanism from #64

**What prompted this**: the identical `duplicate field selected: InsureBridge__Email__c` error, this time traced via a live debug log stack trace directly into `getSObjectRecords.getRecordsDynamically` (the 6-arg overload) at its `Database.Query(soqlQuery)` line — a different method than #64's `buildSOQLQuery`, reached through `getRecordsDynamicallyForLwc`, not `IntegrationUtils`.
**Root cause**: this method enumerates `sObjectFieldMap.Values()` directly from a live describe and can surface two separate `Schema.SObjectField` entries for the same logical field (one bare, one namespaced) — the underlying cause of *why* a describe can carry both wasn't fully re-derived here, but the practical fix is the same shape as #64/#65: dedupe on the canonical (namespace-stripped) name before building the SELECT list.
**Fix**: the field-collection loop now dedupes into a `canonicalToRealField` map keyed by the `Utils.stripNamespacePrefix`-normalized lowercase name, keeping only one real field name per canonical key — preferring the namespaced form whenever both are seen, per the user's specified resolution rule.
**Lesson**: the same *symptom* (`duplicate field selected`) had three genuinely independent root causes across three different methods this session (#64's config-supplies-both-forms, #65's resolver casing bug, #66's dual-describe-entry enumeration) — don't assume a recurrence of a known error string is the same bug recurring; trace the actual stack trace to the actual throwing line every time.

### 67. `sendRFQLayout.js`'s email-domain whitelist blocked every email when the insurer had none configured

**What prompted this**: a business complaint — "There are no email domains allowed for this insurer. Please contact your administrator." appearing for every insurer, not just ones meant to be restricted.
**Root cause**: `_validateEmailDomain` treated a blank/unconfigured `Account.Allowed_Domains__c` (an optional whitelist field) as "block every domain" instead of "no restriction configured, allow anything" — backwards for an opt-in field. Confirmed via `Utils.stripNamespaceFromRecord` (used by the backing `sendRFQController.getAccountDetails`) that the field mapping itself was correct; this was a pure client-side logic-polarity bug, not a namespace issue.
**Fix**: when `allowedDomains` is null/empty, `_validateEmailDomain` now returns no error (unrestricted) instead of blocking everything; the restriction only activates once an admin actually populates the field.
**Confirmed isolated**: swept the codebase for a similar optional-whitelist-gate pattern — no other component has one.
**Lesson**: not every reported "namespace-adjacent" bug in this codebase is actually a namespace bug — worth checking the field is even reaching the client correctly (it was) before assuming the boundary rules are at fault; sometimes it's a plain business-logic inversion.

### 68. `sendRFQControllerTest.cls` assigned a `Map<String,Object>` return value to an `Account`-typed variable — a compile error blocking a package version build

**What prompted this**: a `sf package version create` failure — `Illegal assignment from Map<String,Object> to Account` in `sendRFQControllerTest`, surfaced only when attempting to validate an unrelated fix.
**Root cause**: `sendRFQController.getAccountDetails` returns `Map<String,Object>` (via `Utils.stripNamespaceFromRecord`, per Rule #3), but its test declared `Account result = sendRFQController.getAccountDetails(...)` — a pre-existing type mismatch that had never been caught because nothing had triggered a full package build recompiling this test since it was written.
**Checked for the same pattern elsewhere**: `CDAccountDashboardControllerTest.cls`'s superficially similar `Account result = CDAccountDashboardController.getAccountDetails(...)` is safe — that particular `getAccountDetails` genuinely returns `Account`, no namespace-stripping involved. `subPolicySetupControllerTest.cls` calls the Map-returning methods without a typed variable, so it was never exposed.
**Fix**: both occurrences in `sendRFQControllerTest.cls` changed to `Map<String, Object> result = ...`.
**Lesson**: a compile error in a rarely-rebuilt test class can sit dormant indefinitely until the next full package version build — routine "does it still compile" checks via `sf package version create` catch this class of drift that incremental source deploys to a subscriber org never would.

### 69. A stray extra `</div>` broke `installmentScheduleManager`'s layout — unrelated to namespacing, a plain markup bug

**What prompted this**: a user-reported "extra `</div>`" in `installmentScheduleManager.html`.
**Root cause**: a duplicate closing `</div>` immediately after the `schedule-meta-strip` div's own closer, mis-nesting everything that followed for the rest of the template.
**Fix**: removed the one duplicate line; verified by walking the full tag tree with a proper multi-line-aware `<div>`/`</div>` counter (a naive per-line regex undercounts multi-line opening tags and gives false positives).
**Lesson**: not every fix in this codebase is a namespace issue — plain markup/logic bugs get reported too, and the fix-verification method matters: a line-by-line brace counter can itself be wrong for tags that span multiple lines.

### 70. A dangling, incomplete method declaration in `InsurebridgeProductUsage.cls` broke compilation for two dependent classes and an LWC

**What prompted this**: a cluster of compile errors — `InsurebridgeProductUsage: Unexpected token '}'`, cascading into "Dependent class is invalid" on `CustomerEnrichmentService`/`CustomerEnrichmentServiceTest`/`InsurebridgeProductUsageTest`, and "Unable to find Apex action class" on the `customerProfileEnrichment` LWC.
**Root cause**: an abandoned edit left `public static Boolean` — no method name, no body — dangling at the end of the class before the closing brace, an incomplete declaration with no test or caller referencing it.
**Fix**: removed the dangling fragment; verified brace balance restored (10/10).
**Why the LWC error looked unrelated**: an LWC's `@salesforce/apex` import can't resolve to a class that's currently uncompilable, even though the class and method genuinely exist and the LWC's own code is fine — this is a pure downstream cascade, not a separate bug needing its own fix.
**Lesson**: when several errors reference several different classes/components at once, check whether they're all downstream of one shared broken dependency before treating each as independent — fixing the one root class resolved all six reported errors.

### 71. `transferRequestForm.js`'s `type` vs `transactionType` typo was the real, previously-undiagnosed cause of a recurring "internal server error"

**What prompted this**: the exact same generic `An internal server error has occurred` toast recurring on `processRefundRequest`/`processTransferRequest` even after #62/#63's `global`-visibility fixes were confirmed deployed and live in the target org.
**Root cause**: `transferRequestForm.js` built its request payload with a `type: txnType` key, but `CDAccountFundingController.TransactionRequest`'s actual field is `transactionType`. `@AuraEnabled` parameter binding strictly deserializes the incoming JSON into the typed `TransactionRequest` class *before* the Apex method body runs — an unrecognized `type` property throws a deserialization exception at the platform layer, producing the identical generic error message as #62's namespace-resolution failure, for a completely unrelated reason.
**How this was distinguished from #62 recurring**: confirmed via `sf package installed list` that the target org already had the package version containing the #62/#63 fix, and via `sf org list metadata` that the deployed class matched current source — ruling out a stale-deploy explanation before looking for a different root cause.
**Fix**: `transferRequestForm.js`'s request object key changed from `type` to `transactionType`. Checked `newDepositForm.js` (different calling convention — individual scalar params, not the wrapper type, unaffected) and `policyPaymentForm.js` (all keys already match `TransactionRequest`'s fields) for the same mismatch — confirmed isolated to this one file.
**Lesson**: two structurally unrelated bugs (a platform type-resolution failure and a client-side field-name typo) can produce byte-for-byte identical user-facing error text. Confirming the fix for one root cause is actually deployed and live is a prerequisite before concluding a recurrence means that fix was wrong — it may mean a second, different bug produces the same symptom.

### 72. Two more `containsKey()`-against-a-live-describe-map bugs, one of them independent of namespacing entirely

**What prompted this**: an explicit request to audit `CDAccountFundingController.applyPolicyContextToTransaction` and `getProductClassificationValue`, then `PaymentValidationService.validateEndorsementPaymentEligibility`, for the Rule #4 unsafe pattern.
**`applyPolicyContextToTransaction`**: `txFields.containsKey('Insurer__c')`/`'Product_Classification__c'`/`'Classification__c'` — bare-literal checks against a live `Payment_Transaction__c` describe map — would return `false` forever once packaged (map keys are always the real, namespaced names). **Deeper finding**: none of these three fields exist on `Payment_Transaction__c` under *any* name, bare or namespaced — the method is dead code independent of the namespace fix; the namespace-safe pattern was still applied (`Utils.resolveSObjectType`/`Utils.resolveFieldApiName`) for correctness, without guessing at what the "real" intended field name should be.
**`getProductClassificationValue`**: identical shape — `productFields.containsKey('Classification__c')` against `Product__c`'s describe, and `'Classification__c'` also doesn't exist on `Product__c` under any name (only `Product_Class__c` and `ProductClass__c` do, both used for a different purpose elsewhere in the codebase). Same fix pattern applied; same "field doesn't exist, not fixing the business logic" caveat flagged rather than guessed.
**`PaymentValidationService.validateEndorsementPaymentEligibility`**: a genuinely different, more serious variant — `endFields.containsKey('Payment_Paid__c')` (mixed case) against `Endorsement__c`'s describe map. Since `describe.fields.getMap()` keys are **always lowercase**, this check could never match *regardless of namespace* — a pure casing bug, live in every org, packaged or not, silently disabling the "already paid" duplicate-payment guard. `Endorsement__c` itself is confirmed to not exist anywhere in this package's metadata — it's a genuinely foreign, subscriber-owned object (hence the pre-existing `Utils.resolveSObjectType(...) == null` guard); every field reference on it, plus the dynamic query's field list and `FROM` clause, was routed through `Utils.resolveFieldApiName`/the resolved `SObjectType`'s `getName()` for defense-in-depth, even though the object will likely never actually be InsureBridge-namespaced.
**Lesson**: `Map.containsKey()` against a Schema describe result is unsafe for two independent reasons, not one — the namespace prefix (Rule #4's original concern) *and* the guaranteed-lowercase casing of the keys. A literal like `'Payment_Paid__c'` fails the second way even in a codebase with no namespace at all.

### 73. `PolicyParticipationReCalculation`'s hardcoded dynamic-SOQL string replaced with a Utils-resolved field list, on request for consistency rather than a live bug

**What prompted this**: an explicit request that this class "should not have references to hardcoded field API names," after establishing that its existing hardcoded literals were not, in fact, exposed to a live namespace bug (same-namespace Apex + literal text in dynamic SOQL auto-resolves per Rule #2).
**What changed anyway**: `PARTICIPATION_SELECT_FIELDS` (one long hand-typed SOQL string) replaced with three `Set<String>` field lists (`PARTICIPATION_OWN_FIELDS`, `PREMIUM_DETAILS_FIELDS`, `POLICY_PARTICIPATION_FIELDS`) and a `buildParticipationQuery` method that resolves every field — and both relationship names (`Premium_Details__r`, `Policy_Participation__r`, derived from their resolved lookup field names via a `__c`→`__r` suffix swap) — through `Utils.resolveFieldApiName` against the live describe. The `WHERE`-clause `Policy_Participation__c` field and the `FROM`-clause object name are resolved the same way, via a captured `DescribeSObjectResult` rather than a repeated bare `PremiumTypePolParticipation__c` literal.
**Confirmed not a live bug beforehand** — recorded here as a *pattern consistency* fix, not a corrective one, since every other "remove hardcoded field names" entry in this log (#64–#66, #72) was a genuine, currently-broken defect.
**Lesson**: not every fix applying an established safe pattern is fixing an active bug — sometimes the ask is legitimately "make this consistent with how we've hardened everything else," which is worth doing (a class using literal SOQL today is one refactor away from acquiring #64's exact bug if its describe ever gains a colliding bare/namespaced field pair) even without a reproduced failure.

### 74. Standalone unmanaged duplicates for subscriber-side iteration; discovered that a standard Lightning Experience action override can never select a bare LWC

**What prompted this**: a request for faster iteration on `initiateRFQAction`/`CDAccountFundingController`-adjacent work without needing a full package version bump per change, followed by a request to build a brand-new "Register Claim" LWC (replacing `Claim_Creation_Screen_Flow`) installable manually into a subscriber org.
**Built, all in `force-app/unmanaged/`, fully namespace-converted per Rule #1**: `InitiateRFQStandaloneController.cls` + `initiateRFQActionStandalone` LWC (a duplicate, not a replacement, of the managed `initiateRFQAction`/`initiateRFQActionController` — both remain live); a standalone copy of `PolicyCreationController`/`policyCreation` alongside the pre-existing managed originals; `CreateClaimController.cls` + `createClaim` LWC, newly authored to replicate `Claim_Creation_Screen_Flow`'s full logic (both entry points — with/without a Policy `recordId` — the "Updated Policy Version" resolution, and the claims-details form with its validation rules), explicitly *without* the flow's `Skip_the_execution`/`Disable_Flows__c` kill-switch, per instruction.
**Every standalone class is self-contained** — `Utils`/`ErrorLogger`'s methods are `public`, not `global`, and are therefore *inaccessible* to code outside the namespace; each standalone controller reimplements what it needs directly (`Schema.getGlobalDescribe()`-based `getPicklistValues`, `SObjectType` token comparisons, direct `System.debug` logging) rather than attempting to call into the managed package — confirmed this is the *only* option, not a shortcut, and codified as a standing rule in `CLAUDE.md` so it isn't "fixed" backwards in a future session.
**New platform-limitation finding**: `createClaim`'s `js-meta.xml` (`lightning__RecordAction` + `ScreenAction`) does not make it selectable in Object Manager's "New button → Override With → Lightning Component" picker — that picker only lists **Aura** components implementing `lightning:actionOverride`; a pure LWC is never eligible there regardless of its metadata targets. Fixed by adding `createClaimOverride`, a thin Aura wrapper (`implements="lightning:actionOverride,force:hasRecordId"`) embedding `<c:createClaim record-id="{!v.recordId}">` — the same pattern already used for `policyCreation` via `callPolicyCreationFlowWrapper`.
**Lesson**: "expose an LWC to X" has at least three genuinely different mechanisms in this codebase depending on what X is — a Quick Action (`lightning__RecordAction` target is sufficient on its own), an App Builder page component (`lightning__RecordPage`/`lightning__AppPage` targets), and a standard-button override (requires an Aura wrapper, full stop, independent of any LWC-side configuration). Confirming which mechanism actually applies before configuring metadata saves a round trip.

### 75. Package version `ancestorVersion`/`versionNumber` drift recurs whenever a version is released outside the current working session

**What prompted this**: `sf package version create` failing repeatedly, several times in the same session, with `ErrorAncestorNotHighestError` and then `INVALID_INPUT: ... version number ... already exists` — each time pointing at a *newer* released version than `sfdx-project.json` expected.
**Root cause**: something outside this session's own tool calls (another process, or the user directly) was periodically releasing new package versions, advancing the "highest released version" past what `sfdx-project.json`'s `ancestorVersion`/`versionNumber` fields recorded — confirmed each time via `sf package version list --released` before touching the config, never assumed.
**Fix pattern, repeated several times**: bump `ancestorVersion` to the actual latest released `major.minor.patch`, and bump `versionNumber`'s `major.minor.patch.NEXT` to one above that, then retry. Each retry surfaced the *next* stale value rather than resolving in one pass, since the gap could be more than one version.
**Lesson**: this project's package version registry moves independently of any single working session — never assume a config value recorded earlier (even earlier in the same session) is still current; re-verify against `sf package version list` at the moment of failure rather than incrementing blindly from the last-known value.

---

# Part IV — Unmanaged/Standalone Metadata: What's There and Why

*Source: the README that lived alongside the standalone/unmanaged metadata folder (path varies — see the note at the top of this document).*

This folder holds two kinds of things: (1) metadata that genuinely **cannot** be packaged in 2GP at all — `Group`, `Queue`, `ApprovalProcess` (hard Salesforce restrictions), plus dependents; (2) metadata that *could* be packaged but was deliberately moved anyway — FlexiPages, CustomApplications, Permission Sets, Permission Set Groups. CustomApplication's `profileActionOverrides` can never be packaged regardless of generation (documented behavior); FlexiPages hit several independent packaging bugs (cross-object namespace issues, action-validation failures, Dashboard-Id embedding); once those two were out, Permission Sets/Groups followed by strategy: ship a minimal 2GP core, deploy everything here as a faithful copy via a documented second step. Nothing here is a lesser version of what's in `force-app/` — same content, different deploy mechanism. All of it is excluded from `sfdx-project.json`'s package directory, so `sf package version create` never picks it up. Full history: see Part III.

### Deploying this folder

```bash
scripts/unmanaged-deploy/deploy-unmanaged.sh <target-org>
```
Detects whether the target org needs the `InsureBridge__` prefix, rewrites the namespace-sensitive categories (Permission Sets' object/field references, FlexiPages' cross-object field references) into a temp copy, and deploys via `sf project deploy start`. See `scripts/unmanaged-deploy/apply-namespace-to-metadata.js` for exactly what's rewritten — only Permission Sets and FlexiPages reference custom object/field names directly; everything else here is namespace-agnostic and deploys as-is. **Does not** handle anything requiring Setup UI clicks (PSG assignment, FlexiPage activation, Group/Queue membership) — see "Manual setup steps" and [MANUAL_FLEXIPAGE_ASSIGNMENT_GUIDE.md](MANUAL_FLEXIPAGE_ASSIGNMENT_GUIDE.md).

### What's here

- `groups/` — Public Groups: `Finance_Team`, `Central_Travel_Desk`
- `queues/` — Queue: `Finance_Team`
- `approvalProcesses/` — `Expense_Voucher__c.Expense_Voucher_Approval_Process`, `Travel_Request__c.Travel_Request_Approval_Process`, `Travel_Request__c.Travel_Request_Exception_Approval_Proces`
- `objects/InsureBridge__Expense_Voucher__c/listViews/Finance_Team_Expense_Voucher` — Queue-scoped list view with no independent filter; nested under `objects/<Object>/listViews/` since ListView is a child metadata type (a flat folder fails with "Could not infer a metadata type").
- `profiles/Insurebridge User.profile-meta.xml` — a single custom Profile kept alongside the Permission Set model (already correctly namespaced); not part of the original "zero Profiles" plan but self-contained and non-conflicting.
- `workflows/Travel_Request__c.workflow-meta.xml` — the entire classic Workflow (3 alerts, 8 field updates) — moved in full since classic Workflow bundles everything for an object into one file (see #27).
- `flows/Travel_Request_After_Create_Update_Flow` — checks Central Travel Desk configuration and notifies the group; confirmed nothing else references it by name.
- `email/Staff_Expense_Management/Inform_Central_Travel_Desk_For_Approved_Travel_Request` — the template used exclusively by the moved workflow alert (`.email` + `.email-meta.xml`).
- `flexipages/` — all 131 FlexiPages (128 originally packaged + 3 already here for the Dashboard-Id issue). Moved per #32; the 7 confirmed cross-object custom field references across 6 pages (`Policy_Participation_Record_Page`, `Request_For_Quote_Record_Credit1` + 13 `Request_For_Quote_Record_*` variants, `Grade_wise_Emp_Count_and_Sum_Insured_Record_Page2`, `Quote_Request_Response_Record_Page2`, `Product_Group_Record_Page`) prefixed per the W-16331777 workaround.
- `applications/` — all 5 CustomApplications (`IB_Connect`, `IB_Schedular`, `Lead_Management`, `Revenue_Management`, `Staff_Expense_Management`). 1,657/1,662 override blocks are unpackageable `profileActionOverrides`; the 2 working plain `actionOverrides` (`LeadHomePage`→`Lead_Management`, `Staff_Expense_Management_Home_Page`→`Staff_Expense_Management`) are covered by the manual assignment guide instead.
- `permissionsets/` (124) and `permissionsetgroups/` (18) — moved by strategy decision, not restriction; only cross-reference found was `applicationVisibilities` in 19 Permission Sets pointing at the 5 apps above (moved together, non-issue).
- `tabs/` (49) — 33 tied to a packaged object carry the `InsureBridge__` prefix; 16 freestanding ones don't (a brief mistaken prefixing of these 16 in Permission Sets was caught and reverted).
- `flows/Claim_Creation_Screen_Flow.flow-meta.xml`, `flows/Policy_Creation_Screen_Flow.flow-meta.xml` — moved after both threw an unexplained internal Salesforce error (`ErrorId ...403713813`) during validation; root cause never identified, moving sidesteps rather than fixes it (see #34).
- `quickActions/InsureBridge__Policy__c.Register_FNOL.quickAction-meta.xml`, `.../New_Policy.quickAction-meta.xml` — moved with the 2 flows above since each `<flowDefinition>` points directly at one.
- `lwc/callClaimCreationFlow/`, `lwc/callPolicyCreationFlow/` — moved with the flows (each embeds its flow via `flow-api-name`).
- `aura/callClaimCreationFlowWrapper/`, `aura/callPolicyCreationFlowWrapper/` — wrap the 2 LWCs above for `flexipage:availableForAllPageTypes` hosting; a dangling `Register_FNOL` reference on the `Policy__c` Layout's action list was removed as a result.
- `aura/showToast/` — a third-party (BSD-3-Clause) component both flows' success screens invoke via `c:showToast`; also still lives in the managed package (other packaged flows use it), but `c:` never resolves across namespaces, so a copy was needed here (safe — fully self-contained).

### Known dependencies (checked before moving)

Most Group/Queue references are dynamic runtime lookups with existing "not found" fallbacks. Two hard, non-fallback dependencies were handled within the package: `Vouchers_Submitted_to_Finance` list view (Expense_Voucher__c) — its filter is independent of the group, kept in-package with sharing changed to all internal users; `Finance_Team_Expense_Voucher` list view — no independent filter, moved to `listViews/` above. The Central Travel Desk alert+Flow were moved out entirely (see #27) rather than patched. **Newly confirmed** (#40): the workflow's 3 alerts and both Approval Processes' submission emails reference 4 classic Email Templates (`Prime_Plus/Travel_Request_Approved`, `Travel_Request_Rejected`, `Travel_Request_Approval_Submission_Email_Template`, `Expense_Voucher_Approval_Submission_Email_Template`) and the `Insurebridge` Letterhead — all still live under `force-app/managed/main/default/`, not `unmanaged/`. A deploy of `unmanaged/` alone fails against a fresh install until these are deployed alongside; `deploy-unmanaged.sh` doesn't yet include this — deploy them manually (or pass extra `--source-dir` args) until it's updated. Approval Processes have no external dependency (adhoc approver steps). **Not moved, confirmed safe**: the `Central_Travel_Desk_Available` CMDT flag — read by 4 unrelated screen flows for unrelated UI logic.

### Manual setup steps (per org/subscriber)

Run `deploy-unmanaged.sh <target-org>` first — it handles every metadata deploy above in one pass. What's left is pure Setup-UI work with no metadata equivalent:
1. Assign the appropriate Permission Set Group(s) to each user — this package's only access mechanism (zero Profiles).
2. Add members to `Finance_Team`/`Central_Travel_Desk` Public Groups and the `Finance_Team` Queue (deploy empty).
3. Set up App/Object/Profile/RecordType FlexiPage assignments via Lightning App Builder — cannot be automated (no packaging/Apex mechanism exists — confirmed via Salesforce docs, see #30). See Part V.
4. Recreate the 2 App-default Tab overrides: `LeadHomePage` for `Lead_Management`, `Staff_Expense_Management_Home_Page` for `Staff_Expense_Management` (Setup → App Manager → Edit → User Interface → Lightning Home page).
5. Re-add `Register_FNOL` to the `Policy__c` page layout's action list (Setup → Object Manager → Policy → Page Layouts).

---

# Part V — Manual FlexiPage Assignment Guide

*Source: `MANUAL_FLEXIPAGE_ASSIGNMENT_GUIDE.md`, which lived alongside the Part IV folder.*

### Why this has to be done by hand

App+Object+Profile+RecordType FlexiPage assignments can only bind to a **Profile** — there's no Permission-Set alternative, and Salesforce doesn't support packaging profile-specific assignments in any 2GP generation (confirmed via documentation). No Apex Metadata API workaround exists either — it supports only Custom Metadata Type records and Layouts, not `CustomApplication` (see #30). This package also ships **zero Profiles** — your own profile names won't match the source org's (`Sales`, `Placement`, `Servicing`, `Admin`, `Finance`, `Endorsement`, `Operations Team`, `Revenue`, etc.); use the reference table to understand which page was intended for which *kind* of user, and assign to your own equivalent profile.

### How to assign a FlexiPage to a Profile + Record Type

1. Open the target App → the object's Lightning Record Page in App Builder (or **Activation** directly).
2. Click **Activation** → **Assign to Apps, Record Types, and Profiles**.
3. Select the App, Record Type, and your equivalent Profile.
4. Save. Repeat per combination — no bulk-assignment UI exists.

### Reference: what the source org had configured

Full configuration preserved as-is in `unmanaged/applications/*.app-meta.xml` (`profileActionOverrides` entries). Format: `App → Object (Record Type if any) → Profile → FlexiPage`.
- **Lead_Management**: `Product__c` → `Servicing`/`Admin`/others → `Product_Record_Page1`; `Contact` (RT `InternalContact`) → `Admin` → `Internal_Contact_Record_Page`; App default Home → `LeadHomePage` (packaged correctly pre-move, no profile attached).
- **Staff_Expense_Management**: App default Home → `Staff_Expense_Management_Home_Page`; various `Expense_Voucher__c`/`Travel_Request__c` assignments per profile (`Sales`, `Placement`, `Finance`, etc.) — see file directly.
- **Revenue_Management**, **IB_Connect**, **IB_Schedular**: almost entirely profile-specific across many objects/record types (1,600+ entries combined) — treat the `.app-meta.xml` files as a lookup table, not something to read start to finish.

### What to prioritize

Don't replicate every entry. Priority order: (1) the 2 App-default Home pages — most noticeable if missing; (2) whatever Object+RecordType pages matter most for your rollout (Policy/Claim/RFQ); (3) profile-specific refinements only as they come up — addable later without a package upgrade (pure Setup UI).

---

# Appendix — Source Documents

| Original file | Covered |
|---|---|
| `docs/2GP PACKAGE PLANNING.md` | Part I |
| `docs/2GP Logs/base_package_v1_remediation_plan.md` | Part II |
| `docs/MANAGED_PACKAGE_ISSUES_AND_FIXES.md` | Part III |
| the standalone-metadata folder's `README.md` | Part IV |
| the standalone-metadata folder's `MANUAL_FLEXIPAGE_ASSIGNMENT_GUIDE.md` | Part V |

**Deliberately excluded** — cover a separate initiative (the Sales-Cloud-to-Platform-License standard-to-custom-object migration: Lead/Opportunity/Product2 → `Lead__c`/`Initial_Need_Assessment__c`/`Product__c`), not 2GP packaging:
- `docs/PRODUCTION_CLASSES_REFACTORING.md`, `docs/PC1_DEPLOYMENT_GUARD_RAILS.md`, `docs/DEPENDENCY_AUDIT.md`, `docs/SLA_TAT_SOLUTION.md`
- `QUICK_START_GUIDE.md`, `MIGRATION_GUIDE.md`, `MIGRATION_INFRASTRUCTURE_SUMMARY.md`, `DEPLOYMENT_SUMMARY.md`

Also excluded: raw, un-triaged deploy-error log files under `docs/2GP Logs/` (`base package v1`, `base package v2`, `base package v3`) — point-in-time data dumps referenced by name from Part III, not reproduced here.
