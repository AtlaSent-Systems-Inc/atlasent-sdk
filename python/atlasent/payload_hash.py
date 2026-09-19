"""Execution-payload digests, in the two forms the runtime actually binds.

There are TWO and they are NOT interchangeable. ``/v1-verify-permit`` compares
the digest a caller presents against whichever one the permit was bound to at
evaluate time, folding case and normalizing nothing else, so presenting the
wrong FORM of the right digest is a deterministic ``PAYLOAD_MISMATCH``:

1. **Caller-supplied binding — BARE lowercase 64-hex, no prefix.** When an
   evaluate request carries a top-level ``execution_payload_hash`` matching
   ``^[0-9a-f]{64}$``, ``v1-evaluate`` lowercases it and signs it into the
   permit as ``execution_hash_expected``. This is the binding that means
   something: the caller chose what to digest, so re-deriving it at the
   execution boundary detects a payload that changed after authorization.
   A ``sha256:``-prefixed value fails that pattern and is DROPPED, not
   rejected — allow, permit, 200, no error.

2. **Server fallback binding — ``sha256:`` + 64-hex.** With no caller digest,
   the permit is bound to the server's own hash of the whole evaluate request
   body (``v1-evaluate``'s ``proofPayloadHash``, via ``_shared/canonical.ts``'s
   ``hashPayload``, which PREFIXES the scheme). :func:`server_payload_hash`
   reproduces it.

Getting form 2's prefix wrong is not hypothetical: every ``protect()`` and
``with_permit()`` call presented a bare-hex mirror of the server's prefixed
hash, so the two could never compare equal. The digest MATERIAL was correct —
verified byte-identical to the server's canonicalization across unicode,
escape, numeric and key-ordering vectors (see
``tests/test_payload_hash_parity.py``) — and the scheme prefix alone denied
the permit.

The two pre-existing tests over the old helper asserted that it was
deterministic and that it changed when the payload changed. Both are true of
the broken version, which is why neither caught this.

:func:`canonicalize_payload` must stay byte-identical to
``atlasent-api/supabase/functions/_shared/canonical.ts::canonicalize`` (whose
own header says the same from the other side: "Must stay in lock-step with the
SDK and the standalone verifier").
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any

from .exceptions import AtlaSentError

_BARE_HEX = re.compile(r"^[0-9a-f]{64}$", re.IGNORECASE)

__all__ = [
    "canonicalize_payload",
    "is_bare_payload_hash",
    "normalize_caller_payload_hash",
    "server_payload_hash",
]


def canonicalize_payload(payload: Any) -> str:
    """Deterministic JSON: object keys sorted at every depth, no whitespace.

    Byte-identical to the server's ``canonicalize``. Two details are
    load-bearing and easy to "tidy" into a divergence:

    * ``ensure_ascii=False`` — the server's ``JSON.stringify`` emits non-ASCII
      characters literally. Escaping them to ``\\uXXXX`` here would change
      every digest over a payload containing one.
    * ``separators=(",", ":")`` — no whitespace, matching ``JSON.stringify``.

    Keys are sorted with Python's default string ordering (code points). The
    server sorts with JavaScript's ``Array.prototype.sort`` (UTF-16 code
    units). Those agree for every key in the Basic Multilingual Plane, which
    is every realistic field name; they can disagree for a key containing a
    non-BMP character (an emoji in a KEY, not a value). Recorded rather than
    worked around: a surrogate-order shim would be untested speculation about
    a shape no caller sends, and the parity test covers the realistic range.
    """
    return json.dumps(
        _sort_deep(payload), separators=(",", ":"), ensure_ascii=False, sort_keys=False
    )


def _sort_deep(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _sort_deep(v) for k, v in sorted(obj.items())}
    if isinstance(obj, list):
        return [_sort_deep(i) for i in obj]
    return obj


def is_bare_payload_hash(value: Any) -> bool:
    """True when ``value`` is a bare 64-char hex digest (case-insensitive)."""
    return isinstance(value, str) and bool(_BARE_HEX.match(value))


def server_payload_hash(payload: Any) -> str:
    """Reproduce the server's fallback binding: ``"sha256:" + hex``.

    The ``sha256:`` prefix is part of the value, not decoration —
    ``_shared/canonical.ts::hashPayload`` adds it, ``v1-evaluate`` persists the
    result to ``execution_evaluations.payload_hash`` and signs it into the
    permit, and ``v1-verify-permit`` compares the presented digest against it
    verbatim. Returning bare hex here is the exact defect this module
    documents.

    ``payload`` is the evaluate request body as sent on the wire, minus the
    three fields the server strips before hashing (``traceparent``, ``shadow``,
    ``explain``). A body carrying a field the caller did not mirror hashes
    differently on the server.
    """
    digest = hashlib.sha256(canonicalize_payload(payload).encode("utf-8")).hexdigest()
    return f"sha256:{digest}"


def normalize_caller_payload_hash(digest: str) -> str:
    """Normalize a caller digest to the bare lowercase hex form, or RAISE.

    Raising is deliberate and fail-closed. The runtime drops a malformed digest
    silently on the ordinary-action path — allow, permit, 200, no error, and no
    way for the caller to learn at evaluate time that the permit it just
    received is not bound to the payload it named. Refusing at the client
    boundary turns silent non-enforcement into a loud programming error.

    A leading ``<algo>:`` prefix is stripped first, because ``sha256:<hex>`` is
    the conventional form for a container-image or ``sha256sum`` digest and is
    what a caller most plausibly holds. Anything that is not 64 hex characters
    after that is a caller bug, not a form to guess at.
    """
    if not isinstance(digest, str):
        raise AtlaSentError(
            "execution_payload_hash must be a string SHA-256 digest as 64 hex "
            f"characters. Got: {type(digest).__name__}.",
            code="bad_request",
        )
    # Split on the FIRST colon, matching the TypeScript SDK's indexOf(":").
    # rpartition would disagree on a multi-colon value, which is the kind of
    # silent cross-language divergence this module exists to stop.
    _, _, stripped = digest.partition(":") if ":" in digest else ("", "", digest)
    if not is_bare_payload_hash(stripped):
        raise AtlaSentError(
            "execution_payload_hash must be a SHA-256 digest as 64 hex "
            'characters (an optional "sha256:" prefix is accepted and '
            f"stripped). Got: {digest!r}. The runtime silently DROPS a "
            "malformed digest rather than rejecting it, which mints a permit "
            "not bound to your payload — so this is refused here instead.",
            code="bad_request",
        )
    return stripped.lower()
