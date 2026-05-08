"""Economic Evidence Bundles — priority 1.

Mirrors ``atlasent-sdk/typescript/src/economicEvidence.ts``.

Signing model:

- ``compute_content_hash`` produces a deterministic SHA-256 hex over the
  canonicalized signable content. Pure stdlib; always available.
- ``serialize_signable_content`` produces the canonical UTF-8 bytes that
  an Ed25519 private key signs over. Pure stdlib.
- Actual Ed25519 signing/verification requires the optional
  ``cryptography`` extra (``pip install 'atlasent[verify]'``). The
  ``signature`` and ``signing_key_id`` fields on ``EconomicEvidenceBundle``
  are populated by the caller; this module deliberately does not own a
  signing key, mirroring the TS module.

Wire-stable as ``economic_evidence.v1``.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from typing import Literal, Optional, Sequence

from ._canonical import canonicalize_for_evidence
from .financial_action import FinancialExecutionRecord

EvidencePurpose = Literal[
    "regulator_review",
    "insurance_review",
    "financial_audit",
    "legal_discovery",
    "internal_review",
    "dispute_resolution",
]


@dataclass(frozen=True)
class ApprovalProvenance:
    """Approval provenance record within the evidence bundle."""

    approver_id: str
    approver_label: str
    permit_id: str
    approved_at: str
    audit_hash: str
    role: str


# Forward-declared shape for liability_attribution.LiabilityAttributionRecord.
# Imported lazily in the dataclass type annotation to avoid a circular import:
# liability_attribution does not depend on economic_evidence.
from .liability_attribution import LiabilityAttributionRecord  # noqa: E402
from .financial_quorum import FinancialQuorumResult  # noqa: E402
from .budgetary_governance import BudgetConstraintCheckResult  # noqa: E402


@dataclass(frozen=True)
class EconomicEvidenceBundle:
    """Complete economic evidence bundle.

    Mirrors the TS ``EconomicEvidenceBundle`` interface field-for-field.
    Evidence bundles are append-only and content-addressed via
    ``content_hash``.
    """

    bundle_id: str
    org_id: str
    purpose: EvidencePurpose
    execution_record: FinancialExecutionRecord
    liability_attribution: LiabilityAttributionRecord
    quorum_result: FinancialQuorumResult
    budget_check: BudgetConstraintCheckResult
    approval_provenance: Sequence[ApprovalProvenance]
    runtime_conformity: bool
    runtime_conformity_notes: Sequence[str]
    policy_compliant: bool
    policy_violations: Sequence[str]
    generated_at: str
    requested_by: str
    content_hash: str
    signature: Optional[str] = None
    signing_key_id: Optional[str] = None
    version: Literal["economic_evidence.v1"] = "economic_evidence.v1"


@dataclass(frozen=True)
class EvidenceBundleSignableContent:
    """Canonical content shape that gets hashed and signed.

    Field order is load-bearing: it MUST match the TS
    ``buildSignableContent`` literal order so that
    ``canonicalize_for_evidence`` produces byte-equivalent output.
    Because ``canonicalize_for_evidence`` sorts dict keys lexicographically,
    the **literal order** in the dataclass definition does not affect bytes
    — but it does affect human reading and matches the TS source 1:1.
    """

    bundle_id: str
    org_id: str
    purpose: EvidencePurpose
    execution_id: str
    attribution_id: str
    liability_chain_hash: str
    approval_count: int
    permit_ids: Sequence[str]
    policy_compliant: bool
    generated_at: str

    def to_dict(self) -> dict:
        """Dict representation suitable for canonicalization."""
        return {
            "bundle_id": self.bundle_id,
            "org_id": self.org_id,
            "purpose": self.purpose,
            "execution_id": self.execution_id,
            "attribution_id": self.attribution_id,
            "liability_chain_hash": self.liability_chain_hash,
            "approval_count": self.approval_count,
            "permit_ids": list(self.permit_ids),
            "policy_compliant": self.policy_compliant,
            "generated_at": self.generated_at,
        }


@dataclass(frozen=True)
class EvidenceBundleVerificationResult:
    """Result of ``verify_evidence_bundle_structure`` (no signature check)."""

    valid: bool
    content_hash_valid: bool
    signature_valid: bool
    liability_chain_hash_matches: bool
    permit_ids_match: bool
    reason: Optional[str] = None


def build_signable_content(
    *,
    bundle_id: str,
    org_id: str,
    purpose: EvidencePurpose,
    execution_record: FinancialExecutionRecord,
    liability_attribution: LiabilityAttributionRecord,
    approval_provenance: Sequence[ApprovalProvenance],
    policy_compliant: bool,
    generated_at: str,
) -> EvidenceBundleSignableContent:
    """Build the signable content object for a bundle.

    Mirrors ``buildSignableContent`` in TS exactly. Key order in the
    returned shape matches the TS source for human-readable parity;
    canonicalization is order-insensitive (keys are sorted) so the
    bytes are deterministic regardless.
    """
    return EvidenceBundleSignableContent(
        bundle_id=bundle_id,
        org_id=org_id,
        purpose=purpose,
        execution_id=execution_record.execution_id,
        attribution_id=liability_attribution.attribution_id,
        liability_chain_hash=liability_attribution.chain_hash,
        approval_count=len(approval_provenance),
        permit_ids=tuple(a.permit_id for a in approval_provenance),
        policy_compliant=policy_compliant,
        generated_at=generated_at,
    )


def serialize_signable_content(content: EvidenceBundleSignableContent) -> bytes:
    """Serialize signable content to canonical UTF-8 bytes.

    Uses ``canonicalize_for_evidence`` — byte-equivalent to the TS
    ``serializeSignableContent`` (which calls
    ``new TextEncoder().encode(canonicalizeForEvidence(content))``).
    """
    return canonicalize_for_evidence(content.to_dict()).encode("utf-8")


def compute_content_hash(content: EvidenceBundleSignableContent) -> str:
    """Return the SHA-256 hex digest of the canonical signable bytes."""
    return hashlib.sha256(serialize_signable_content(content)).hexdigest()


def verify_evidence_bundle_structure(
    bundle: EconomicEvidenceBundle,
) -> EvidenceBundleVerificationResult:
    """Verify an economic evidence bundle's structural integrity.

    Mirrors ``verifyEvidenceBundleStructure`` in TS. Does NOT verify the
    Ed25519 signature — that requires the ``cryptography`` extra and a
    public-key registry. Use ``atlasent.audit_bundle.verify_audit_bundle``
    as the model for cross-language signature verification.
    """
    errors: list[str] = []

    # Permit ID consistency between provenance and execution record
    bundle_permit_ids = set(bundle.execution_record.permit_ids)
    provenance_permit_ids = [a.permit_id for a in bundle.approval_provenance]
    permit_ids_match = all(pid in bundle_permit_ids for pid in provenance_permit_ids)
    if not permit_ids_match:
        errors.append(
            "permit IDs in approval provenance do not all appear in execution record"
        )

    # Content hash format check (SHA-256 hex = 64 chars)
    content_hash_valid = (
        isinstance(bundle.content_hash, str) and len(bundle.content_hash) == 64
    )
    if not content_hash_valid:
        errors.append("content_hash appears invalid (expected 64-char hex)")

    # Liability chain hash presence
    chain_hash = bundle.liability_attribution.chain_hash
    liability_chain_hash_matches = isinstance(chain_hash, str) and len(chain_hash) > 0
    if not liability_chain_hash_matches:
        errors.append("liability_attribution.chain_hash is missing or empty")

    signature_valid = bundle.signature is not None and len(bundle.signature) > 0

    valid = len(errors) == 0 and content_hash_valid
    reason = None if valid else (errors[0] if errors else "bundle integrity check failed")

    return EvidenceBundleVerificationResult(
        valid=valid,
        content_hash_valid=content_hash_valid,
        signature_valid=signature_valid,
        liability_chain_hash_matches=liability_chain_hash_matches,
        permit_ids_match=permit_ids_match,
        reason=reason,
    )


__all__ = [
    "ApprovalProvenance",
    "EconomicEvidenceBundle",
    "EvidenceBundleSignableContent",
    "EvidenceBundleVerificationResult",
    "EvidencePurpose",
    "build_signable_content",
    "compute_content_hash",
    "serialize_signable_content",
    "verify_evidence_bundle_structure",
]
