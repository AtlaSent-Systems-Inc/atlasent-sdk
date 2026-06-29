#!/usr/bin/env bash
# One-command, offline verification of the AtlaSent evidence bundle.
#
# Runs BOTH reference verifiers against bundle.json + trust-root.json and
# reports a single PASS/FAIL. The two are independent implementations (Python
# via the published `atlasent[verify]` SDK; Node via a zero-dependency stdlib
# script you can read in full) — they must agree.
#
# Neither verifier touches the network. Nothing here trusts AtlaSent's running
# system: you are recomputing the hashes, the Merkle root, and the Ed25519
# signature yourself against a published public key.
#
#   ./verify.sh
#
# Exit 0 only if every available verifier returns PASS.

set -uo pipefail
cd "$(dirname "$0")"

BUNDLE="${1:-bundle.json}"
TRUST_ROOT="${2:-trust-root.json}"
overall=0
ran=0

echo "AtlaSent evidence-bundle verification"
echo "  bundle:     $BUNDLE"
echo "  trust root: $TRUST_ROOT"
echo

# ── Python (published SDK: pip install 'atlasent[verify]') ─────────────────
if command -v python3 >/dev/null 2>&1; then
  if python3 -c "import atlasent.evidence_bundle_verifier" >/dev/null 2>&1; then
    ran=$((ran + 1))
    echo "── Python (atlasent SDK) ──────────────────────────────────────────"
    if python3 verify.py "$BUNDLE" "$TRUST_ROOT"; then :; else overall=1; fi
    echo
  else
    echo "── Python: skipped (run: pip install 'atlasent[verify]') ──────────"
    echo
  fi
else
  echo "── Python: skipped (python3 not found) ────────────────────────────"
  echo
fi

# ── Node (zero-dependency stdlib script) ───────────────────────────────────
if command -v node >/dev/null 2>&1; then
  ran=$((ran + 1))
  echo "── Node (zero-dependency stdlib) ──────────────────────────────────"
  if node verify.mjs "$BUNDLE" "$TRUST_ROOT"; then :; else overall=1; fi
  echo
else
  echo "── Node: skipped (node not found) ─────────────────────────────────"
  echo
fi

if [ "$ran" -eq 0 ]; then
  echo "RESULT: no verifier could run. Install Python (pip install 'atlasent[verify]') or Node."
  exit 2
fi

if [ "$overall" -eq 0 ]; then
  echo "RESULT: PASS — $ran independent verifier(s) agree the bundle is authentic and intact."
else
  echo "RESULT: FAIL — at least one check did not pass. Do NOT rely on this bundle."
fi
exit "$overall"
