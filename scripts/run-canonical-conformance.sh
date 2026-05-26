#!/usr/bin/env bash
# Validate every fixture under tests/canonical-fixtures/ against the
# corresponding canonical schema vendored at vendor/atlasent-canonical/v1-rc/.
#
# Filename convention is the verdict:
#   valid_*.json     MUST validate
#   rejected_*.json  MUST NOT validate
#
# Any other prefix is a hard error.
#
# Phase 2 of the cross-repo parity gate (PHASE-2-PARITY-PLAN.md in
# atlasent). Phase 1 (the vendored-pin hash check) already runs in
# .github/workflows/canonical-schema-parity.yml; this script adds the
# semantic conformance dimension.
#
# Requires:
#   - node + npx in PATH (CI installs)
#   - jq for nicer error output
#
# Usage:
#   scripts/run-canonical-conformance.sh
#
# Exit codes:
#   0   all fixtures conformed
#   1   one or more fixtures failed the verdict their filename promises
#   2   bad filename prefix / missing dependency / missing schema
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
schemas_dir="$repo_root/vendor/atlasent-canonical/v1-rc"
fixtures_root="$repo_root/tests/canonical-fixtures"

if [[ ! -d "$schemas_dir" ]]; then
  echo "ERROR: vendored canonical schemas not present at $schemas_dir" >&2
  exit 2
fi
if [[ ! -d "$fixtures_root" ]]; then
  echo "ERROR: fixtures dir not present at $fixtures_root" >&2
  exit 2
fi

# Map shape directory → schema filename.
declare -A SCHEMA_FOR
SCHEMA_FOR[evaluate-request]="evaluate-request.schema.json"
SCHEMA_FOR[decision-snapshot]="decision-snapshot.schema.json"
SCHEMA_FOR[permit]="permit.schema.json"
SCHEMA_FOR[audit-chain-entry]="audit-chain-entry.schema.json"

# Per-target ref list is built below in the loop, because ajv-cli
# rejects loading the target schema both via -s and -r ("schema
# with key or id already exists").

fail=0
total=0

echo "Canonical schema conformance (Phase 2)"
echo "  schemas: $schemas_dir"
echo "  fixtures: $fixtures_root"
echo

for shape_dir in "$fixtures_root"/*/; do
  shape=$(basename "$shape_dir")
  schema_name="${SCHEMA_FOR[$shape]:-}"
  if [[ -z "$schema_name" ]]; then
    # Skip non-shape directories (e.g. README sit at fixtures_root, not inside a subdir)
    continue
  fi
  schema_path="$schemas_dir/$schema_name"
  if [[ ! -f "$schema_path" ]]; then
    echo "ERROR: schema for $shape not found at $schema_path" >&2
    fail=1
    continue
  fi

  # Build -r list for this target: every sibling schema EXCEPT the
  # one being validated against (ajv-cli rejects duplicate $id).
  ref_args=()
  for sibling in "$schemas_dir"/*.schema.json; do
    [[ "$sibling" == "$schema_path" ]] && continue
    ref_args+=(-r "$sibling")
  done

  echo "── $shape (schema: $schema_name) ──"

  shopt -s nullglob
  for fixture in "$shape_dir"*.json; do
    fname=$(basename "$fixture")
    total=$((total + 1))

    case "$fname" in
      valid_*)    expected="valid"   ;;
      rejected_*) expected="reject"  ;;
      *)
        echo "  [BAD NAME]  $fname"
        echo "              fixture filenames must start with valid_ or rejected_"
        fail=1
        continue
        ;;
    esac

    # ajv-cli exits 0 on valid, 1 on invalid. We turn both into a
    # boolean and compare to expectation.
    if npx --yes -p ajv-cli@5 -p ajv-formats@3 ajv validate \
         -s "$schema_path" \
         "${ref_args[@]}" \
         --spec=draft2020 \
         --strict=false \
         -c ajv-formats \
         -d "$fixture" >/dev/null 2>&1; then
      got="valid"
    else
      got="reject"
    fi

    if [[ "$got" == "$expected" ]]; then
      printf "  [OK]        %s\n" "$fname"
    else
      printf "  [MISMATCH]  %s  (expected=%s got=%s)\n" "$fname" "$expected" "$got"
      # Re-run with verbose output for the failing case so CI shows why.
      npx --yes -p ajv-cli@5 -p ajv-formats@3 ajv validate \
        -s "$schema_path" \
        "${ref_args[@]}" \
        --spec=draft2020 \
        --strict=false \
        -c ajv-formats \
        --all-errors \
        -d "$fixture" 2>&1 | sed 's/^/              /' || true
      fail=1
    fi
  done
  shopt -u nullglob
done

echo
if [[ $fail -ne 0 ]]; then
  echo "Conformance FAILED ($total fixtures checked)" >&2
  cat >&2 <<EOF

If a valid_* fixture now fails:
  - The schema may have legitimately tightened. If the tightening is
    intentional and the fixture should now be rejected, rename the
    fixture from valid_*.json to rejected_*.json.
  - Otherwise the fixture must be updated to conform.

If a rejected_* fixture now passes:
  - The schema may have loosened. If the loosening is intentional,
    rename the fixture from rejected_*.json to valid_*.json.
  - Otherwise the schema needs to tighten again, or the rejection
    case needs a different trigger.

If a fixture has [BAD NAME]:
  - Rename so the prefix matches the verdict (valid_ or rejected_).

See tests/canonical-fixtures/README.md for the full doctrine.
EOF
  exit 1
fi

echo "Conformance PASSED ($total fixtures checked)"
