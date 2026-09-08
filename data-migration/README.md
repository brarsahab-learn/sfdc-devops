# data-migration/

Self-contained data-migration toolkit for the Insurebridge Primeplus package:
a reference/master data set (captured from pc-10trillion, or whichever org
was last pulled — see "Refreshing from a different org" below) plus the
scripts to load, clear, reset, or pull it against any org.

**Portable by design:** this entire folder can be copy-pasted into any other
project as-is. Every script resolves its own paths via its location on disk
(`__dirname` in the JS files, `$(dirname "$0")` in the shell wrapper), so
nothing here depends on where it's dropped or what the caller's working
directory is. The only prerequisite is that the target org has the same
Insurebridge Primeplus package/objects installed.

## Master control script

```
node data-migration/dm.js                 # interactive menu - pick org/object from a list
node data-migration/dm.js load   --target-org <org> [--object <Name|all>]
node data-migration/dm.js status --target-org <org>
node data-migration/dm.js clear  --target-org <org> [--object <Name|all>] [--yes]
node data-migration/dm.js reset  --target-org <org> [--object <Name|all>] [--yes]
node data-migration/dm.js pull   --source-org <org> [--yes]
node data-migration/dm.js users  --target-org <org> --org-code <code> [--user <email|all>] [--yes]
```

`dm.js` is the single entry point for every DM operation - load, clear,
reset, status, pull, and admin-user creation all go through it, either via
its interactive menu (lists connected orgs and seed objects to choose from)
or the flag-driven form above for scripting. `--yes` skips the confirmation
prompt on destructive operations. Load/reset also run the Insurer
record-type fixup and sample-location seeding automatically afterward. See
"Loading System Administrator Users" below for what `users` does.

The interactive menu remembers the org you picked within that session: once
you've selected one, later operations offer `0) Keep using '<org>'` instead
of showing the full org list again - press Enter or `0` to reuse it, or `1`
to pick a different one. This memory is per-run only (in-memory, not
persisted to disk); each fresh `node data-migration/dm.js` starts without a
remembered org.

`data-migration/setup-initial-data.sh --target-org <org> [--object <Name|all>] [--reset|--clear|--status]`
is a thin, non-interactive wrapper around the same underlying
`load-seed-data.js`, kept for scripts/CI that expect a shell command.

`load-seed-data.js` itself is the tracked/resumable loader both of the above
drive:

- Every record it creates is recorded in `seed/.tracking/<org>.json`
  (gitignored — it's per-org load state, not seed content). Re-running the
  same command only (re)attempts records that are still pending or
  previously failed; already-created records are left alone.
- `--object <Name>` scopes to one object (its unloaded prerequisites earlier
  in `plan.json`'s order load automatically first); omit or pass `all` for
  everything.
- `--clear [--object <Name|all>]` deletes every record this tool tracked as
  created, for that object **and everything after it** in dependency order
  (so nothing is left pointing at a deleted parent), and forgets the tracking
  — without reloading.
- `--reset [--object <Name|all>]` does the same clear, then reloads.
- `--status` prints a created/failed/pending table straight from the
  tracking file — no org calls, safe to run anytime.
- Every run ends with that same table, so you always see exactly how many
  records were created vs. failed, per object.
- Failures capture the actual Salesforce error (bad field, validation rule,
  flow, etc.) in the tracking file — fix the underlying issue in the org,
  then just rerun; only the failed records retry.

## Refreshing from a different org

```
node data-migration/pull-seed-data.js <source-org>
# or: node data-migration/dm.js pull --source-org <source-org>
```

Regenerates every file in `seed/` (including `plan.json`'s dependency order)
from whichever org you point it at, and updates the Insurer name list baked
into `apex/fix-insurer-record-types.apex` to match. Since the tree export's
`referenceId`s are regenerated fresh, any existing `seed/.tracking/*.json`
files are cleared as part of a pull — they'd no longer correspond to the new
data. The export itself runs against a scratch temp directory first — if it
fails partway through (wrong org, missing package metadata, etc.), `seed/` is
left completely untouched rather than partially wiped.

### Controlling what gets pulled — `pull-objects.json`

Which objects are captured, and the SOQL query used for each, is entirely
driven by `data-migration/pull-objects.json` — a plain JSON array you can
edit by hand:

```json
[
  { "sobject": "Product_Group__c", "query": "SELECT Id, Name FROM Product_Group__c" },
  { "sobject": "Product__c", "query": "SELECT Id, Name, Product_Group__c FROM Product__c" },
  { "sobject": "Broker__c" }
]
```

- Add an object by appending a new `{ "sobject": ..., "query": ... }` entry.
  Remove one by deleting its entry — its old `seed/<Sobject>.json` file is
  cleaned up automatically on the next pull.
- **`query` is optional.** Omit it (as `Broker__c` does above) and the script
  auto-builds `SELECT Id, <editable fields> FROM <sobject>` from that
  object's describe in the source org — no need to hand-list every field.
  Auto-built queries always drop `RecordTypeId` and any reference field
  pointing at User/Group (`OwnerId`, etc.), since those values aren't
  portable across orgs (same reasoning as the Insurer record-type handling
  below). There's no WHERE clause, so an auto-built query pulls *every*
  record of that object — write an explicit `query` if you need filtering,
  record-type scoping, or relationship traversal (see next point).
- **Order matters**: it's also the dependency/load order used for
  `plan.json`. List an object *after* anything it looks up via a lookup/
  master-detail field referenced in its query (e.g. `Product_Group__c` before
  `Product__c`, since `Product__c`'s query selects `Product_Group__c`) so the
  tree-export tool can auto-link the reference instead of embedding a
  non-portable literal Id.
- To pull a lookup as a proper cross-object reference (rather than a
  hardcoded Id), select the relationship by traversal in the *same pull*
  (e.g. `Product_Group__c` must be one of the entries) — plain field
  selection like `Product_Group__c` in the query resolves automatically as
  long as the parent object is also listed.
- The script validates the file on every run (must be a non-empty array,
  every entry needs a string `sobject` and, if present, a string `query`)
  and fails with a clear error rather than a confusing SOQL error if
  something's malformed.

## What's in the tree (`seed/plan.json`, load order)

| Object | Records | Notes |
|---|---:|---|
| Product Group (`Product_Group__c`) | 4 | |
| Team (`Team__c`) | 16 | `Team_Lead__c` (User lookup) excluded — Users aren't portable across orgs |
| Product (`Product__c`) | 91 | linked to Product Group |
| Component Master (`Component_Master__c`) | 550 | |
| Broker (`Broker__c`) | 620 | |
| Account — Insurer record type | 34 | `RecordTypeId` intentionally omitted (see below) |
| Product Component (`Product_Component__c`) | 1043 | linked to Product + Component Master |
| Product Team Mapping (`Product_Team_Mapping__c`) | 16 | linked to Team + Product Group |
| Office Locations (`Broker_Office_Location__c`) | 44 | linked to Insurer Accounts; 2 records tied to non-Insurer (`Master`) accounts were excluded from the export |
| Contact — Insurer Contact record type | 36 | linked to Insurer Accounts; `RecordTypeId` intentionally omitted (see below) |
| Product Insurer Mapping (`Product_Insurer_Mapping__c`) | 2345 | linked to Product + Insurer Account |

## Why Account/Contact record types are handled separately

`RecordTypeId` values are specific to the org they were exported from —
hardcoding pc-10trillion's Insurer/Insurer-Contact record type Ids into the
tree files would silently misassign (or fail on) any other org. So the
Account and Contact tree files carry only the plain data, and
`apex/fix-insurer-record-types.apex` runs immediately after import to set the
correct record type for this target org, matching:
- Accounts by the Insurer names captured at the last pull
- Contacts by `AccountId` membership in that same Insurer Account set

**Caveat:** this match is by **name across the whole org**, not scoped to
records this toolkit itself just created. If a target org already has
unrelated Accounts/Contacts that happen to share one of these names (e.g.
pre-existing sample data under a different record type), running load/reset
will retype those too. This was observed directly in a scratch-org test.
Safe for a clean org or one dedicated to this data set; double-check before
running against an org that might have naming overlap from other sources.

## Locations

`Client_Location__c` had no real data in pc-10trillion to capture, so
`apex/seed-locations.apex` inserts a small set of representative sample
locations instead.

## Loading System Administrator Users

```
node data-migration/dm.js users --target-org <org> --org-code <code> [--user <email|all>] [--yes]
```

Creates real Salesforce `User` records from `system-admin-users.json` - an
editable list of `{ "email": ... }` entries (add/remove people by editing
that file; every other field is derived, not stored):

- **FirstName**: the email's local-part (before `@`), title-cased
- **LastName**: `defaults.lastName` in the config (currently `"Admin"`)
- **Username**: `<firstname-lowercased>@ib.<org-code>` - the org code is
  arbitrary per org (e.g. `PP01`, `PP02`) with no reliable way to derive it,
  so it's always passed explicitly via `--org-code`
- **Alias**: first 8 characters of FirstName
- **Profile**: `defaults.profileName` in the config (currently
  `"System Administrator"`), resolved to a real Profile Id in the target org

`--user <email>` loads just one person; omit or pass `all` for everyone in
the config. Idempotent: skips anyone whose derived Username already exists
in the target org.

**This creates real users and sends a real email** - each new user is set
Active immediately and gets a welcome/password-reset email via
`System.resetPassword` (the standard way to trigger that email for
API-created users; a plain insert doesn't send one on its own). It also
consumes a Salesforce user license seat per person created. The
confirmation prompt says this explicitly - read it before typing `YES`, and
don't pass `--yes` unless you're certain.

## Re-running

- `setup-initial-data.sh` / `dm.js load` are meant for **other** target orgs,
  not the org the data was last pulled from — loading tree data into its own
  source org duplicates everything in it (the loader has no way to know
  those records already exist there under different Ids).
- `fix-insurer-record-types.apex` and `seed-locations.apex` are themselves
  idempotent (they only touch/insert records that don't already match), and
  run automatically after a normal load/reset (skipped for
  `--status`/`--clear`-only invocations).

## Folder layout

```
data-migration/
  dm.js                      master control script (interactive + flag-driven)
  load-seed-data.js          tracked/resumable loader
  pull-seed-data.js          refresh seed/ from any source org
  pull-objects.json          editable list of { sobject, query } to pull
  load-admin-users.js        creates System Admin Users from system-admin-users.json
  system-admin-users.json    editable list of { email } admins to create
  setup-initial-data.sh      shell wrapper around load-seed-data.js
  lib/
    namespace.js             resolves unprefixed vs InsureBridge__-prefixed API names
    tracking.js              per-org load-tracking file I/O
  apex/
    fix-insurer-record-types.apex
    seed-locations.apex
  seed/
    plan.json                dependency-ordered tree-import plan
    *.json                   tree-export data files
    .tracking/                gitignored, per-org load state
```
