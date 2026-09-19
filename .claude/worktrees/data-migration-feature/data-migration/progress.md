# SDD ledger — plan: docs/superpowers/plans/2026-09-08-data-migration-external-id-upsert.md

## Preflight conflict scan

Spec reachable: yes — docs/superpowers/specs/2026-09-08-data-migration-external-id-upsert-design.md, read.

| Pair | Produces | Consumes | Finding |
|---|---|---|---|
| Task 2 (namespace.js) / Task 5 (csvBuild.js) | `relationshipName(fieldApiName): string`, `prefixCustomApiName` | csvBuild imports both from ./namespace | match, no conflict |
| Task 3 (recordFlatten.js) / Task 7 (pull-seed-data.js) | `flattenRecordTypeAndId(record): object` | pull-seed-data.js calls it per record | match |
| Task 4 (queryBuild.js) / Task 7 | `buildFieldListQuery`, `appendRecordTypeFields` | pull-seed-data.js calls both | match |
| Task 5 (csvBuild.js) / Task 8 (load-seed-data.js) | `recordsToCsv(records, lookupFieldNames, nsPrefix)` | load-seed-data.js calls it in upsertRecords | match |
| Task 6 (pull-objects.json) / Task 7 | `active`/`query`/`where` schema, mutually exclusive query+where | pull-seed-data.js validates and reads exactly this shape | match |
| Task 1 (External_Id__c field-meta) / Task 8 (sf data upsert bulk --external-id) | field must exist in target org at runtime | Task 8 Step 6 already gates live verification behind explicit user go-ahead | no conflict — runtime dependency, not a build dependency |
| Task 9 (dm.js) / Task 8 (load-seed-data.js CLI surface) | same `--target-org`/`--object`/`--reset`/`--clear`/`--status` flags | dm.js spawns load-seed-data.js via execFileSync, no direct JS import | match, no coupling risk |
| Task 6 object list / Global Constraints object list | 11 objects, exact order | Task 1's 11 field-meta files, same order | match |

Self-consistency: every task's own test list asserts a real value (no vacuous
assertions); Task 1 batches all 11 field-meta files as one task per the
"batch small same-shape work" rule — already sized correctly, no split
needed; Task 8's one known-unverified assumption (`sf data upsert bulk
--json` shape) is explicitly flagged in the plan with its own verification
step, not a hidden defect.

Scan is clean — no rulings needed before execution begins.

## Task log
Task 1: minor (deferred): implementer substituted a narrower existence-check command in Step 1 instead of the brief's exact repo-wide find (no effect on correctness — Policy__c already had an unrelated External_Id__c field, correctly excluded from scope).
Task 1: complete (commits 6b473b8..448da24, review clean)
Task 2: minor (deferred): relationshipName() doesn't special-case external-object lookup relationship-name suffixes (e.g. __pr) — out of scope, no such field exists in this toolkit's object set.
Task 2: complete (commits 448da24..2a9e32b, review clean)
Task 3: Ruling: reviewer flagged (Important, plan-mandated) that flattenRecordTypeAndId() unconditionally deletes RecordTypeId even when no nested RecordType is present, and sets RecordTypeDeveloperName without checking DeveloperName exists — contradicts the brief's prose in the abstract. Ruling: not reachable in this toolkit's actual pipeline — Task 4's appendRecordTypeFields (consumed by Task 7) always appends RecordTypeId and RecordType.DeveloperName as a pair, never one without the other, and no pull-objects.json entry selects RecordTypeId alone. Code stands as-is; no fix dispatched. Cost if wrong: a future pull-objects.json entry that hand-writes an explicit query selecting RecordTypeId without RecordType.DeveloperName would silently lose RecordTypeId with no replacement — low likelihood, and would surface immediately as a load-side "record inserted with default record type" warning, not silent data corruption.
Task 3: minor (deferred): no test covers the RecordTypeId-without-RecordType input shape (same root cause as the ruling above).
Task 3: complete (commits 2a9e32b..c4265f8, 1 parked)
Task 4: minor (deferred): appendRecordTypeFields's regex FROM-insertion would misfire on a literal " FROM " substring inside a WHERE clause/subquery — none of this toolkit's actual queries do that; plan-prescribed implementation.
Task 4: complete (commits c4265f8..1f9294d, review clean)
Task 5: minor (deferred): recordsToCsv assumes every record shares records[0]'s keys, no defensive check (matches brief's contract, no validation requested).
Task 5: minor (deferred): no test for a namespaced standard lookup (relationship name unprefixed, external-id field prefixed) — inferred correct by review, not directly asserted.
Task 5: complete (commits 1f9294d..df40fd8, review clean)
Task 6: complete (commits df40fd8..bf3dbdc, review clean; controller independently re-ran python3 JSON validation to resolve reviewer's ⚠️ item — confirmed valid, 11 entries)
Task 7: Ruling: reviewer found (Important, plan-mandated) that the stale-seed-file cleanup loop treats plan.json itself as an orphaned sobject file, deleting it and printing a misleading "Removed stale seed/plan.json" message every single run (harmless — plan.json is regenerated two lines later — but confusing during real debugging). This bug was in the brief's own Step 2 code verbatim. Ruling: fix it — real, cheap, no downside — by skipping plan.json explicitly in that loop. Dispatching fix round 1 to the original implementer. Cost if wrong: none identified; this is a strict correctness improvement to a log message with no behavior-changing side effect either way.
Task 7: minor (deferred): task-7-report.md's line-number citations don't exactly match the committed file (off by ~2-3 lines) — report-accuracy nit only.
Task 7: minor (deferred): fs.mkdirSync(SEED_DIR, {recursive:true}) runs once per object inside the loop instead of once before it — harmless no-op redundancy, inherited from brief.
Task 7: fix round 1/5 (dispatching plan.json stale-cleanup fix to original implementer)
Task 7: fix round 1/5 (1 addressed, 0 open; commits 40582d1..abdf811)
Task 7: complete (commits bf3dbdc..abdf811, 2 minor parked, 1 fixed)
Task 8: Ruling: reviewer found 1 Critical + 3 Important, all traceable to code given verbatim in the plan's own brief (plan-mandated) rather than implementer deviation. Ruling: fix all 4 — these are genuine correctness bugs that violate the spec's actual intent ("RecordTypeId and every lookup resolve correctly on the very first upsert... reliably", "reruns never duplicate"), not stylistic disagreements with the plan. Deferring would ship a loader that silently drops resolved RecordTypeId on mixed-shape batches and reports false success on a result-shape mismatch. Dispatching fix round 1 to the original implementer with the reviewer's exact findings and required fixes:
  1. (Critical) applyRecordType/prepared produce ragged key sets across a batch; recordsToCsv derives headers from records[0] only, silently dropping RecordTypeId (and any field) missing from record 0 for other rows. Fix: normalize every record in `prepared` to the same key set before batching (always set RecordTypeId to '' when RecordTypeDeveloperName was present but unresolved is not enough - the real fix is a stable key superset across all records in a batch, e.g. compute the union of keys across `prepared` and fill missing keys with '' before calling recordsToCsv).
  2. (Important) No guard if parsed.result.records is missing/malformed - degrades to [] and reports false total success (0/0/0 counters, exit 0). Fix: throw/mark-failed if rows.length !== records.length.
  3. (Important) Row-to-record correlation by array position (records[i]) is unsafe per Bulk API 2.0's documented behavior. Fix: read the external id back off the result row itself (row[namespacedExternalId]) instead of indexing by i.
  4. (Important) No fail-fast check that seed files are in the new flat format - all 11 committed seed/*.json files are still old Tree-shape (pending Task 7's pull re-run), so a load run today would silently produce garbage CSVs (attributes column, @Ref literal lookup values). Fix: add a guard in loadObject that throws a clear "re-run pull-seed-data.js" error if a record has no External_Id__c key or still has an attributes key.
Cost if wrong: none identified — these are strict correctness fixes with no plausible reading under which the old (unfixed) behavior was intentional; the reviewer's Critical finding was independently reproduced against the real csvBuild.js library, not a theoretical concern.
Task 8: fix round 1/5 (4 addressed, 1 new Important introduced in fix diff, 2 new minor — commits e101583..42adde8)
Task 8: minor (deferred): rows.length mismatch error message renders "parsed.result keys: []" rather than saying "absent" when parsed.result itself is missing — cosmetic wording only.
Task 8: minor (deferred): stale-seed-format guard only samples allRecords[0], not every file in a multi-file entry.files — latent, since every current plan.json entry has exactly one file; becomes live only if pull-seed-data.js ever chunks an object across files.
Task 8: fix round 2/5 (dispatching guard for undefined external id from Bulk result row)
