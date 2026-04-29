"""SHA-256 hex of the canonical JSON of an arbitrary value.

The primary use case is the Pillar 9 ``payload_hash`` — the hash the
SDK computes client-side so the raw payload never crosses the wire.
Matches the server-side computation for any value that round-trips
through :func:`canonicalize_payload`.

See:

* ``contract/schemas/v2/consume-request.schema.json`` — ``payload_hash``
* ``contract/schemas/v2/proof.schema.json`` — ``payload_hash``
"""

from __future__ import annotations

import hashlib
from typing import Any

from .canonicalize import canonicalize_payload


def hash_payload(value: Any) -> str:
    """Return the lowercase SHA-256 hex digest of the canonical JSON of ``value``."""
    canonical = canonicalize_payload(value)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
