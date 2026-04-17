"""Pydantic models for AtlaSent API requests and responses."""

from __future__ import annotations

from dataclasses import dataclass, field
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


# ── Authorize (public top-level API) ─────────────────────────────────


@dataclass
class AuthorizationResult:
    """Result of an :func:`atlasent.authorize` call.

    This is the primary return type for the public SDK surface.
    Check :attr:`permitted` to decide whether to proceed.

    Attributes:
        permitted: ``True`` if the action is authorized and verified.
        agent: The agent identifier passed to ``authorize``.
        action: The action name passed to ``authorize``.
        context: The context dict passed to ``authorize``.
        reason: Human-readable explanation from the policy engine.
        permit_token: Opaque decision identifier for audit lookup.
        audit_hash: Hash-chained audit trail entry (21 CFR Part 11).
        permit_hash: Verification hash bound to the permit.
        verified: ``True`` if the permit was server-verified end-to-end.
        timestamp: ISO 8601 timestamp of the authorization decision.
        raw: The raw JSON response body from the API.

    Example::

        result = authorize(agent="clinical-agent", action="read_phi")
        if result.permitted:
            do_the_thing()
        else:
            logger.warning("Denied: %s", result.reason)
    """

    permitted: bool
    agent: str = ""
    action: str = ""
    context: dict[str, Any] = field(default_factory=dict)
    reason: str = ""
    permit_token: str = ""
    audit_hash: str = ""
    permit_hash: str = ""
    verified: bool = False
    timestamp: str = ""
    raw: dict[str, Any] = field(default_factory=dict)

    def __bool__(self) -> bool:
        """Truthy iff the action was permitted.

        Allows the idiomatic ``if authorize(...):`` check.
        """
        return self.permitted
