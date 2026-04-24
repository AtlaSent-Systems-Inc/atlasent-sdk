"""``atlasent-v2-preview`` — PREVIEW.

DO NOT USE IN PRODUCTION. Exports here are subject to change
without semver discipline until v2 GA. See ``./README.md``.
"""

from __future__ import annotations

from .canonicalize import canonicalize_payload
from .hash import hash_payload
from .types import (
    ConsumeExecutionStatus,
    ConsumeRequest,
    ConsumeResponse,
    Proof,
    ProofCheckName,
    ProofDecision,
    ProofExecutionStatus,
    ProofFailureReason,
    ProofVerificationCheck,
    ProofVerificationResult,
    ProofVerificationStatus,
)
from .verify_proof import (
    GENESIS_HASH,
    ProofBundleVerificationResult,
    ProofVerificationEntry,
    VerifyKey,
    load_verify_keys,
    replay_proof_bundle,
    signed_bytes_for_proof,
    verify_proof,
)

__version__ = "2.0.0a0"

__all__ = [
    "__version__",
    "canonicalize_payload",
    "hash_payload",
    "ConsumeExecutionStatus",
    "ConsumeRequest",
    "ConsumeResponse",
    "Proof",
    "ProofCheckName",
    "ProofDecision",
    "ProofExecutionStatus",
    "ProofFailureReason",
    "ProofVerificationCheck",
    "ProofVerificationResult",
    "ProofVerificationStatus",
    "GENESIS_HASH",
    "ProofBundleVerificationResult",
    "ProofVerificationEntry",
    "VerifyKey",
    "load_verify_keys",
    "replay_proof_bundle",
    "signed_bytes_for_proof",
    "verify_proof",
]
