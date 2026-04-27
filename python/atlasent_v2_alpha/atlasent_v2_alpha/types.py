"""v2 Pillar 9 — Verifiable Proof System model definitions.

Every pydantic model here is a structural mirror of a schema file
under ``contract/schemas/v2/``. Drift between schema and model is
caught by ``tests/test_types.py``, which asserts that each required
schema field is declared on the corresponding pydantic class.

Fields stay snake_case (wire-identical). The eventual ``atlasent`` v2
release may layer a camelCase-friendly surface on top; this preview
package keeps the wire shape so byte-level tooling (signature checks,
canonical hashing) needs no translation.

``model_config = {"extra": "allow"}`` on the Proof model mirrors the
v1 audit-bundle approach: forward-compatible servers can add fields
without breaking older clients, and ``model_dump(mode="json")`` round-
trips the full envelope for signature verification.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# ── String unions ────────────────────────────────────────────────────

ProofDecision = Literal["allow", "deny", "hold", "escalate"]
"""Policy decision values that can produce a proof."""

ProofExecutionStatus = Literal["executed", "failed", "pending"]
"""Outcome of the callback wrapped by ``protect()``.

``"pending"`` is reserved for proofs fetched before the consume step
completes (async execution path).
"""

ConsumeExecutionStatus = Literal["executed", "failed"]
"""Outcome allowed on the consume request side — no ``"pending"``."""

ProofVerificationStatus = Literal["valid", "invalid", "incomplete"]
"""Top-level verification status.

``"valid"`` iff every item in ``checks`` passed. ``"incomplete"`` is
reserved for proofs whose consume step has not yet landed.
"""

ProofCheckName = Literal[
    "signature",
    "chain_link",
    "payload_hash",
    "policy_version",
    "execution_coherence",
]
"""Canonical verification-check names. New names are additive."""

ProofFailureReason = Literal[
    "missing_policy_version",
    "payload_hash_mismatch",
    "expired_permit",
    "broken_chain",
    "invalid_signature",
    "retired_signing_key",
    "execution_not_consumed",
]
"""Machine-readable failure reasons.

Present on a check result iff ``passed is False``.
"""


# ── Models ────────────────────────────────────────────────────────────


class Proof(BaseModel):
    """The canonical 18-field Verifiable Proof Object.

    Declaration order below IS the Ed25519 signed-byte order — reorder
    at your peril. Mirrors the v1 audit-bundle envelope / ``handleExport``
    relationship.

    See ``contract/schemas/v2/proof.schema.json``.
    """

    proof_id: str
    """Server-assigned UUID for the proof."""

    permit_id: str
    """The permit (v1 ``decision_id``) this proof binds to."""

    org_id: str
    """Organization the proof belongs to."""

    agent: str = Field(min_length=1)
    """Agent identifier as submitted on the originating evaluate call."""

    action: str = Field(min_length=1)
    """Action as submitted on the originating evaluate call."""

    target: str
    """Target resource identifier.

    Empty string when the action has no discrete target.
    """

    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    """SHA-256 hex of ``canonicalize_payload(payload)``.

    Computed client-side; raw payload never hits the wire.
    """

    policy_version: str
    """Opaque identifier of the policy bundle version that produced the decision."""

    decision: ProofDecision
    """Policy decision that produced the permit."""

    execution_status: ProofExecutionStatus
    """Outcome of the callback the SDK wrapped."""

    execution_hash: str | None
    """Optional SHA-256 hex of execution-result metadata.

    ``None`` when the caller didn't supply one.
    """

    audit_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    """Audit-chain entry id — bridge between ``/v2/proofs`` and the v1 audit chain."""

    previous_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    """Prior audit-chain hash. ``"0" * 64`` for genesis."""

    chain_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    """``SHA-256(previous_hash || canonicalJSON(this proof payload))``."""

    signing_key_id: str
    """Registry id of the Ed25519 key that produced ``signature``."""

    signature: str
    """Detached Ed25519 signature (base64url, no padding).

    Covers canonicalJSON of the 18 fields in declaration order. Empty
    string on signing failure — verifiers MUST treat that as
    ``invalid_signature``.
    """

    issued_at: str
    """ISO 8601 timestamp of the consume call that produced this proof."""

    consumed_at: str | None
    """ISO 8601 timestamp of when the callback completed.

    ``None`` for proofs fetched before consume.
    """

    model_config = {"extra": "allow"}


class ConsumeRequest(BaseModel):
    """Request body for ``POST /v2/permits/:id/consume``.

    See ``contract/schemas/v2/consume-request.schema.json``.
    """

    permit_id: str
    """Decision id from the originating ``/v2/evaluate`` call."""

    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    """SHA-256 hex of ``canonicalize_payload(payload)``."""

    execution_status: ConsumeExecutionStatus
    """Outcome of the wrapped callback."""

    execution_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    """Optional SHA-256 hex of execution-result metadata.

    Omit when the caller has nothing to bind.
    """

    api_key: str
    """API key echoed in the body for wire parity with ``/v1-evaluate``."""

    model_config = {"extra": "forbid"}


class ConsumeResponse(BaseModel):
    """Response from ``POST /v2/permits/:id/consume``.

    Kept tiny — consume is on the hot path of every ``protect()`` call,
    and callers fetch the full :class:`Proof` via ``GET /v2/proofs/:id``.

    See ``contract/schemas/v2/consume-response.schema.json``.
    """

    proof_id: str
    """UUID of the proof row."""

    execution_status: ConsumeExecutionStatus
    """Echo of the submitted ``execution_status``."""

    audit_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    """Audit-chain hash. Same meaning as :attr:`Proof.audit_hash`."""

    model_config = {"extra": "allow"}


class ProofVerificationCheck(BaseModel):
    """One per-check result in a verification response.

    See ``contract/schemas/v2/proof-verification-result.schema.json``
    ``#/$defs/ProofVerificationCheck``.
    """

    name: ProofCheckName
    """Canonical check name."""

    passed: bool
    """``True`` iff the check succeeded."""

    reason: ProofFailureReason | None = None
    """Machine-readable failure reason.

    Required when ``passed is False``; absent when ``passed is True``.
    """

    model_config = {"extra": "forbid"}


class ProofVerificationResult(BaseModel):
    """Result of ``POST /v2/proofs/:id/verify``.

    Shared shape between the online SDK path
    (:meth:`AtlaSentClient.verify_proof`, v2) and the offline
    ``npx @atlasent/verify proof.json`` CLI.

    See ``contract/schemas/v2/proof-verification-result.schema.json``.
    """

    verification_status: ProofVerificationStatus
    """Top-level status. ``"valid"`` iff every item in ``checks`` passed."""

    proof_id: str
    """Echo of the proof id that was verified."""

    signing_key_id: str | None = None
    """Registry id of the key the signature verified under.

    Absent on signature failure.
    """

    audit_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    """Echo of :attr:`Proof.audit_hash`."""

    payload_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    """Echo of :attr:`Proof.payload_hash`."""

    checks: list[ProofVerificationCheck] = Field(min_length=1)
    """Per-check results."""

    model_config = {"extra": "allow"}


# ──────────────────────────── EvaluateBatch ────────────────────────────

BatchProofStatus = Literal["pending", "executed", "failed", "not_applicable"]
"""Pillar 9 proof SLA reported on a batch evaluate item."""


class BatchEvaluateItem(BaseModel):
    """One entry in :class:`EvaluateBatchRequest.requests`.

    Mirrors v1 EvaluateRequest plus optional ``payload_hash`` /
    ``target`` for items that opt into the Pillar 9 proof flow.

    See ``contract/schemas/v2/evaluate-batch-request.schema.json``.
    """

    action: str = Field(min_length=1, max_length=256)
    """Same semantics as ``/v1-evaluate-request.action``."""

    agent: str = Field(min_length=1, max_length=256)
    """Same semantics as ``/v1-evaluate-request.agent``."""

    context: dict[str, Any]
    """Same semantics as ``/v1-evaluate-request.context``."""

    payload_hash: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    """Optional SHA-256 hex of ``canonicalize_payload(payload)`` — opt-in proof flow."""

    target: str | None = None
    """Optional target resource identifier."""

    model_config = {"extra": "forbid"}


class EvaluateBatchRequest(BaseModel):
    """Wire payload for ``POST /v2/evaluate:batch``.

    See ``contract/schemas/v2/evaluate-batch-request.schema.json``.
    """

    requests: list[BatchEvaluateItem] = Field(min_length=1, max_length=1000)
    """Per-item evaluate requests. 1..1000 items."""

    api_key: str
    """API key echoed in the body."""

    model_config = {"extra": "forbid"}


class BatchEvaluateResponseItem(BaseModel):
    """One entry in :class:`EvaluateBatchResponse.items`.

    Matches the inbound request at ``requests[index]``. See
    ``contract/schemas/v2/evaluate-batch-response.schema.json``.
    """

    index: int = Field(ge=0)
    permitted: bool
    decision_id: str
    reason: str
    audit_hash: str
    timestamp: str
    batch_id: str
    proof_id: str | None = None
    proof_status: BatchProofStatus | None = None

    model_config = {"extra": "allow"}


class EvaluateBatchResponse(BaseModel):
    """Response from ``POST /v2/evaluate:batch``.

    ``items[i]`` decides ``requests[i]`` from the inbound payload —
    order preservation is a wire guarantee.
    """

    batch_id: str
    items: list[BatchEvaluateResponseItem] = Field(min_length=1)

    model_config = {"extra": "allow"}
