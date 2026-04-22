"""Deterministic JSON canonicalization + SHA-256 helpers.

Must stay byte-for-byte in lock-step with the server-side signer and
the TypeScript SDK's ``canonicalize`` (``typescript/src/canonical.ts``).
Any divergence produces non-reproducible signatures, so this module is
dependency-free and intentionally small.

Rules (RFC 8785 JCS for the cases we care about):

- object keys are sorted lexicographically at every depth
- no whitespace
- Python ``None`` → ``"null"`` (same as TS ``null`` / ``undefined``)
- inside an array, ``None`` becomes the literal ``null`` token
- in an object, a ``None`` value is emitted as ``null`` (Python has
  no ``undefined``; if a caller wants a key omitted they should leave
  it out of the dict entirely)
- strings use ``json.dumps`` escaping (``ensure_ascii=False`` so UTF-8
  passes through unchanged, matching ``JSON.stringify``)
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonicalize(value: Any) -> str:
    """Return the canonical JSON string for ``value``.

    The output is the exact bytes the AtlaSent audit-export signer
    feeds into Ed25519, so ``sign(canonicalize(envelope - signature))``
    reproduces the ``signature`` field of the export envelope.
    """
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (
            value != value or value in (float("inf"), float("-inf"))
        ):
            raise ValueError("canonicalize: NaN / Infinity are not JSON-representable")
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        parts: list[str] = []
        for k in sorted(value.keys()):
            if not isinstance(k, str):
                raise TypeError("canonicalize: object keys must be strings")
            parts.append(
                json.dumps(k, ensure_ascii=False) + ":" + canonicalize(value[k])
            )
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"canonicalize: unsupported type {type(value).__name__}")


def sha256_hex(data: str | bytes) -> str:
    """SHA-256 hex digest of ``data`` (UTF-8 encoded when ``str``)."""
    b = data.encode("utf-8") if isinstance(data, str) else data
    return hashlib.sha256(b).hexdigest()
