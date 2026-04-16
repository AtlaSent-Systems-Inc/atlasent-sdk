"""Pydantic models for AtlaSent API requests and responses."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

# ── Evaluate ──────────────────────────────────────────────────────────


class EvaluateRequest(BaseModel):
    """Payload sent to ``POST /v1-evaluate``."""

    action_type: str = Field(..., alias="action")
    actor_id: str = Field(..., alias="agent")
    context: dict[str, Any] = Field(default_factory=dict)
    api_key: str = ""

    model_config = {"populate_by_name": True}


class EvaluateResult(BaseModel):
    """Successful response from ``POST /v1-evaluate``.

    In the fail-closed SDK, you only receive this object when the
    action is **permitted**.  A denial raises :class:`AtlaSentDenied`.

    Attributes:
        decision: The authorization decision (``True`` when permitted).
        permit_token: An opaque token used to verify the permit later.
        reason: Human-readable explanation of the decision.
        audit_hash: Hash-chained audit trail entry.
        timestamp: ISO 8601 timestamp of the decision.
    """

    decision: bool = Field(..., alias="permitted")
    permit_token: str = Field(..., alias="decision_id")
    reason: str = ""
    audit_hash: str = ""
    timestamp: str = ""

    model_config = {"populate_by_name": True}


# ── Verify ────────────────────────────────────────────────────────────


class VerifyRequest(BaseModel):
    """Payload sent to ``POST /v1-verify-permit``."""

    permit_token: str = Field(..., alias="decision_id")
    action_type: str = Field(default="", alias="action")
    actor_id: str = Field(default="", alias="agent")
    context: dict[str, Any] = Field(default_factory=dict)
    api_key: str = ""

    model_config = {"populate_by_name": True}


class VerifyResult(BaseModel):
    """Response from ``POST /v1-verify-permit``.

    Attributes:
        outcome: The verification outcome (e.g. ``"verified"``).
        valid: Whether the permit is still valid.
        permit_hash: The permit hash returned by the API.
        timestamp: ISO 8601 timestamp of the verification.
    """

    outcome: str = ""
    valid: bool = Field(..., alias="verified")
    permit_hash: str = ""
    timestamp: str = ""

    model_config = {"populate_by_name": True}


# ── Gate (convenience) ────────────────────────────────────────────────


class GateResult(BaseModel):
    """Combined result from :meth:`AtlaSentClient.gate`.

    Contains both the evaluation and verification results so callers
    have full audit context in one object.
    """

    evaluation: EvaluateResult
    verification: VerifyResult
