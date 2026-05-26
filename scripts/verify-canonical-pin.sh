#!/usr/bin/env bash
# Verify that the vendored canonical schema files under
# vendor/atlasent-canonical/v1-rc/ match the SHA-256 hashes recorded in
# .atlasent-canonical-pin.json. This is the Phase 1 cross-repo parity
# gate: when the canonical schemas in atlasent change, the vendored
# copies and the pin must be bumped together, and the bump shows up in
# this repo's git history as a deliberate, reviewable diff.
#
# Usage:
#   scripts/verify-canonical-pin.sh
#
# Exit codes:
#   0  vendored files match the pin
#   1  drift: vendored file hash does not match the recorded hash
#   2  vendored file missing
#   3  tooling missing or pin file unreadable
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
pin_file="$repo_root/.atlasent-canonical-pin.json"
vendor_dir="$repo_root/vendor/atlasent-canonical/v1-rc"

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required" >&2
  exit 3
fi
if [[ ! -r "$pin_file" ]]; then
  echo "ERROR: cannot read $pin_file" >&2
  exit 3
fi
if [[ ! -d "$vendor_dir" ]]; then
  echo "ERROR: vendor directory missing: $vendor_dir" >&2
  exit 2
fi

canonical_repo=$(jq -r '.canonical_repo' "$pin_file")
canonical_commit=$(jq -r '.canonical_commit' "$pin_file")
freeze_id=$(jq -r '.canonical_freeze_id' "$pin_file")

echo "Pinned canonical: $canonical_repo @ $canonical_commit ($freeze_id)"
echo "Vendored at: vendor/atlasent-canonical/v1-rc/"

drift=0
while IFS=$'\t' read -r name expected; do
  file="$vendor_dir/$name"
  if [[ ! -f "$file" ]]; then
    printf '  [MISSING]  %s\n' "$name"
    drift=1
    continue
  fi
  actual=$(sha256sum "$file" | awk '{print $1}')
  if [[ "$actual" == "$expected" ]]; then
    printf '  [OK]       %s\n' "$name"
  else
    printf '  [DRIFT]    %s\n             expected sha256:%s\n             actual   sha256:%s\n' \
      "$name" "$expected" "$actual"
    drift=1
  fi
done < <(jq -r '.expected_hashes | to_entries[] | [.key, .value] | @tsv' "$pin_file")

if [[ $drift -ne 0 ]]; then
  cat >&2 <<EOF

Canonical pin is broken.

If this drift is INTENTIONAL (you are bumping the pin):
  1. Confirm the new canonical_commit in atlasent
  2. Copy the five schema files from atlasent/schemas/v1_1/ at that
     commit into vendor/atlasent-canonical/v1-rc/
  3. Update canonical_commit, expected_hashes, and pinned_at in
     .atlasent-canonical-pin.json
  4. Update the corresponding hand-written shapes in
     python/atlasent/models.py, typescript/src/client.ts, and typescript/src/types.ts
     as needed
  5. Re-run this script; it must pass before merge

If this drift is UNINTENTIONAL:
  Revert the change to the affected file in vendor/atlasent-canonical/.
  The vendored copies are pinned read-only mirrors; never edit them
  to "fix" a problem in this repo.

See .atlasent-canonical-pin.json#bump_procedure for the full workflow.
EOF
  exit 1
fi

echo "Canonical pin intact."
