"""Deterministic canonical JSON for the v2 Pillar 9 proof flow.

This function MUST produce identical output to:

* The v1 Python SDK's ``canonical_json`` in
  ``python/atlasent/audit_bundle.py``
* The v1 TypeScript SDK's ``canonicalJSON`` in
  ``typescript/src/auditBundle.ts``
* The ``@atlasent/sdk-v2-preview`` TypeScript implementation in
  ``typescript/packages/v2-preview/src/canonicalize.ts``
* The server-side reference in ``atlasent-api/.../rules.ts``

Rules:
  * Object keys sorted lexicographically at every depth
  * No whitespace between tokens
  * ``None``, ``NaN``, ``+inf``, ``-inf`` all render as ``"null"``
  * Strings use the same escapes as ``json.dumps(ensure_ascii=False)``

Why reimplement rather than import from the v1 SDK? This package
must not take a runtime dependency on v1 until v2 GA decides on a
consolidation story. Byte parity is kept honest via
``tests/test_canonicalize.py``.

See ``contract/schemas/v2/README.md`` §1 — canonicalization.
"""

from __future__ import annotations

import json
import math
from typing import Any


def canonicalize_payload(value: Any) -> str:
    """Return the canonical JSON string for ``value``."""
    return _canonicalize(value)


def _canonicalize(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return json.dumps(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            return "null"
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list):
        return "[" + ",".join(_canonicalize(v) for v in value) + "]"
    if isinstance(value, tuple):
        # Tuples canonicalize like lists — deliberate, matches what
        # ``json.dumps`` would do and avoids a surprising TypeError
        # at the boundary for callers who pass immutable sequences.
        return "[" + ",".join(_canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for k in sorted(value.keys()):
            if not isinstance(k, str):
                # Canonical JSON requires string keys. Mirrors JSON
                # itself — but raise loudly rather than silently
                # stringifying, so callers notice.
                raise TypeError(
                    f"canonical JSON requires string keys, got {type(k).__name__}"
                )
            parts.append(
                json.dumps(k, ensure_ascii=False) + ":" + _canonicalize(value[k])
            )
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"cannot canonicalize {type(value).__name__}")
