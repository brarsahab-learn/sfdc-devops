#!/usr/bin/env bash
#
# Post-install initial data setup for a target org, using the tracked,
# resumable loader (load-seed-data.js). See seed/README.md.
#
# This whole data-migration/ folder is self-contained and portable - drop it
# into any project and every path here resolves relative to its own location,
# not the caller's working directory.
#
# Usage:
#   data-migration/setup-initial-data.sh --target-org <org> [--object <Name|all>] [--reset|--clear|--status]
#
# Examples:
#   data-migration/setup-initial-data.sh --target-org pc1                     # load everything, resumable
#   data-migration/setup-initial-data.sh --target-org pc1 --object Broker__c  # load just one object
#   data-migration/setup-initial-data.sh --target-org pc1 --clear             # delete everything this script loaded
#   data-migration/setup-initial-data.sh --target-org pc1 --reset --object Product__c  # wipe + reload Product__c onward
#   data-migration/setup-initial-data.sh --target-org pc1 --status           # created/failed/pending table, no org calls
#
# To refresh seed/ itself from a (possibly different) source org:
#   node data-migration/pull-seed-data.js <source-org>
#
# Prefer an interactive, menu-driven experience? Use dm.js instead:
#   node data-migration/dm.js

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

node "${SCRIPT_DIR}/load-seed-data.js" "$@"

# Insurer Account/Contact record types and sample Locations aren't part of
# the tracked tree data (RecordTypeId isn't portable across orgs; Locations
# have no real source data) - they stay separate, idempotent steps, and only
# run on a normal full/incremental load (skip for --status/--clear-only, and
# skip when the caller scoped to a single unrelated --object).
if [[ "$*" != *"--status"* && "$*" != *"--clear"* ]]; then
    TARGET_ORG=""
    prev=""
    for i in "$@"; do
        if [[ "$prev" == "--target-org" || "$prev" == "-o" ]]; then TARGET_ORG="$i"; fi
        prev="$i"
    done
    if [[ -n "$TARGET_ORG" ]]; then
        echo "==> Fixing Insurer Account/Contact record types in ${TARGET_ORG}"
        sf apex run --file "${SCRIPT_DIR}/apex/fix-insurer-record-types.apex" --target-org "${TARGET_ORG}"

        echo "==> Seeding sample Locations into ${TARGET_ORG}"
        sf apex run --file "${SCRIPT_DIR}/apex/seed-locations.apex" --target-org "${TARGET_ORG}"
    fi
fi

echo "==> Done"
