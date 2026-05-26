"""Byte-equivalent canonicalizer matching the TS economic-evidence canonicalizer.

Mirrors ``atlasent-sdk/typescript/src/economicEvidence.ts::canonicalizeForEvidence``
byte-for-byte. The two MUST stay in sync — see
``python/tests/governance/test_canonical.py`` for the contract
fixtures and ``typescript/test/governance/canonicalCompat.test.ts``
for the TS-side verifier.

Notable differences from ``atlasent.audit_bundle.canonical_json`` (which
also targets a TS canonicalizer, but the audit one):

- Whole-number floats (e.g. ``1.0``, ``-0.0``) emit as ``"1"``, ``"0"``
  to match ``String(1.0) === "1"`` in TypeScript. The audit bundle
  canonicalizer emits ``"1.0"`` because audit data uses integer-typed
  values throughout. Economic-evidence bundles include monetary values
  that may originate as Postgres ``NUMERIC`` and arrive as Python
  ``float`` after JSON round-trip; without this elision, byte-equivalence
  with the TS canonicalizer breaks.
- Non-finite floats (``NaN``, ``+inf``, ``-inf``) emit as ``"null"``,
  matching the TS ternary ``Number.isFinite(value) ? String(value) : "null"``.
"""

from __future__ import annotations

import json
from typing import Any

_INT_SAFE_BOUND: float = 1e16  # below 2**53 ~= 9.0e15; safe for Number(value) in JS


def canonicalize_for_evidence(value: Any) -> str:
    """Return the canonical UTF-8 string for ``value``.

    Encoding rules (must match ``canonicalizeForEvidence`` in TS):

    - ``None`` → ``"null"``
    - ``bool`` → ``"true"`` / ``"false"``
    - ``int`` → ``json.dumps(value)`` (no scientific notation)
    - ``float``:
        * non-finite (NaN, ±inf) → ``"null"``
        * whole-number and ``abs(value) < 1e16`` → emit as int (no ``.0``)
        * else → ``json.dumps(value)``
    - ``str`` → ``json.dumps(value, ensure_ascii=False)``
    - ``list`` / ``tuple`` → ``"[" + items.join(",") + "]"``
    - ``dict`` → keys sorted lexicographically; each key JSON-stringified
      via ``ensure_ascii=False`` and joined with ``:`` to its canonicalized value;
      enclosed in ``{}`` with ``,`` separators
    - any other type → ``"null"`` (matches TS fallthrough)
    """
    if value is None:
        return "null"
    # bool is a subclass of int in Python — check before int.
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return json.dumps(value)
    if isinstance(value, float):
        if value != value or value in (float("inf"), float("-inf")):
            return "null"
        # Match TS String(): whole-number floats lose the trailing ".0".
        if value == int(value) and abs(value) < _INT_SAFE_BOUND:
            return json.dumps(int(value))
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize_for_evidence(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        parts = [
            json.dumps(k, ensure_ascii=False)
            + ":"
            + canonicalize_for_evidence(value[k])
            for k in keys
        ]
        return "{" + ",".join(parts) + "}"
    return "null"


__all__ = ["canonicalize_for_evidence"]
