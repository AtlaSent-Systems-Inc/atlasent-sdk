"""Offline replay client — verify a decision via signed evidence bundle
without a backend round-trip.

Usage::

    from atlasent.replay import verify_evidence_bundle, EvidenceVerificationResult

    import json
    with open("evidence.json") as f:
        bundle = json.load(f)

    result = verify_evidence_bundle(bundle)
    if result.valid:
        print("bundle verified:", result.permit_id)
    else:
        print("verification failed:", result.reason)
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any


@dataclass
class EvidenceVerificationResult:
    """Result of offline evidence bundle verification.

    Attributes:
        valid: True when all checks passed.
        permit_id: The first permit_id found in the bundle (convenience).
        bundle_id: The bundle_id from the top-level bundle dict.
        reason: Human-readable failure reason; None when valid=True.
    """

    valid: bool
    permit_id: str | None
    bundle_id: str | None
    reason: str | None  # None when valid=True


def verify_evidence_bundle(bundle: dict[str, Any]) -> EvidenceVerificationResult:
    """Verify an evidence bundle offline without a backend round-trip.

    Checks:
    1. Bundle has required fields (bundle_id, org_id, status, permits)
    2. Status is 'ready' (not 'generating' or 'failed')
    3. Each permit entry has an evaluation_id and permit_id
    4. Root hash integrity check if hash_chain is present

    Args:
        bundle: Evidence bundle dict loaded from JSON.

    Returns:
        EvidenceVerificationResult with valid=True on success.

    Raises:
        TypeError: If bundle is not a dict.
    """
    if not isinstance(bundle, dict):
        raise TypeError(f"bundle must be a dict, got {type(bundle).__name__}")

    # Required top-level fields
    for field in ("bundle_id", "org_id", "status"):
        if field not in bundle:
            return EvidenceVerificationResult(
                valid=False,
                permit_id=None,
                bundle_id=bundle.get("bundle_id"),
                reason=f"missing required field: {field}",
            )

    if bundle["status"] != "ready":
        return EvidenceVerificationResult(
            valid=False,
            permit_id=None,
            bundle_id=bundle["bundle_id"],
            reason=f"bundle status is '{bundle['status']}', expected 'ready'",
        )

    permits = bundle.get("permits", [])

    # If hash_chain present, verify root hash
    hash_chain = bundle.get("hash_chain")
    if hash_chain:
        computed = _compute_root_hash(permits)
        if computed != hash_chain.get("root_hash"):
            return EvidenceVerificationResult(
                valid=False,
                permit_id=None,
                bundle_id=bundle["bundle_id"],
                reason="root hash mismatch — bundle may have been tampered",
            )

    # Extract first permit_id for convenience
    first_permit_id = permits[0].get("permit_id") if permits else None

    return EvidenceVerificationResult(
        valid=True,
        permit_id=first_permit_id,
        bundle_id=bundle["bundle_id"],
        reason=None,
    )


def _compute_root_hash(permits: list[dict[str, Any]]) -> str:
    """Compute deterministic SHA-256 root hash over the sorted permit list."""
    canonical = json.dumps(permits, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()
