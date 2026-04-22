"""Canonical types for the AtlaSent execution-time authorization contract.

Two endpoints carry the core surface:

    POST /v1-evaluate       -> EvaluateRequest     -> EvaluateResponse
    POST /v1-verify-permit  -> VerifyPermitRequest -> VerifyPermitResponse

Wire shapes are snake_case and match the server handlers byte-for-byte; there
is no domain/wire translation in this SDK.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

# ── Decision ──────────────────────────────────────────────────────────

Decision = Literal["allow", "deny", "hold", "escalate"]
"""The canonical execution-time decision.

    allow     -- proceed. A permit_token has been issued for exactly one action.
    deny      -- do not proceed. No permit exists and none will be granted.
    hold      -- do not proceed yet. An approval flow must resolve first.
    escalate  -- do not proceed. A higher-authority reviewer must decide.
"""


def is_allowed(decision: Decision) -> bool:
    """True iff ``decision == 'allow'``. Use at every enforcement boundary."""
    return decision == "allow"


# ── Evaluate ──────────────────────────────────────────────────────────


class EvaluateRequest(BaseModel):
    """Body sent to ``POST /v1-evaluate``.

    Authorization is carried in the ``Authorization: Bearer <api_key>`` header;
    the API key is NOT placed in the body.
    """

    action_type: str
    actor_id: str
    context: dict[str, Any] = Field(default_factory=dict)
    request_id: str | None = None
    """Idempotency key. Retries with the same value replay the recorded decision."""
    shadow: bool | None = None
    """Run in shadow mode: evaluate but do not issue permit, do not count as live."""
    explain: bool | None = None
    """Return per-rule ``trace`` in the response."""
    traceparent: str | None = None
    """W3C traceparent for body-level trace propagation."""

    model_config = ConfigDict(extra="forbid")


class RolloutInfo(BaseModel):
    bucket: int | None = None
    group: str | None = None
    in_canary: bool | None = None

    model_config = ConfigDict(extra="ignore")


class ShadowResult(BaseModel):
    decision: Decision
    deny_code: str | None = None

    model_config = ConfigDict(extra="ignore")


class RuleTraceEntry(BaseModel):
    stage: str
    rule: str | None = None
    matched: bool
    detail: str | None = None

    model_config = ConfigDict(extra="ignore")


class EvaluateResponse(BaseModel):
    """Body of a successful ``POST /v1-evaluate`` response.

    Returned on any decision -- ``allow``, ``deny``, ``hold``, ``escalate``.
    Enforcement callers should use :meth:`AtlaSentClient.authorize` or
    :meth:`AtlaSentClient.with_permit` which raise on non-allow decisions.
    """

    decision: Decision
    request_id: str
    mode: Literal["live", "shadow"]
    cache_hit: bool
    evaluation_ms: int

    # Present iff decision == "allow" and mode == "live".
    permit_token: str | None = None
    expires_at: str | None = None

    deny_code: str | None = None
    deny_reason: str | None = None

    fingerprint: str | None = None
    risk_score: float | None = None
    rollout: RolloutInfo | None = None
    shadow: ShadowResult | None = None

    trace: list[RuleTraceEntry] | None = None
    audit_entry_hash: str | None = None
    idempotent_replay: bool | None = None

    model_config = ConfigDict(extra="ignore")


# ── Verify permit ─────────────────────────────────────────────────────

VerifyErrorCode = Literal[
    "MISSING_PERMIT",
    "PERMIT_NOT_FOUND",
    "PERMIT_NOT_ALLOWED",
    "PERMIT_EXPIRED",
    "PERMIT_REVOKED",
    "PERMIT_ALREADY_USED",
    "ACTOR_MISMATCH",
    "ACTION_TYPE_MISMATCH",
    "UNAUTHORIZED",
    "INVALID_API_KEY",
    "INSUFFICIENT_SCOPE",
    "RATE_LIMITED",
    "INTERNAL_ERROR",
]


class VerifyPermitRequest(BaseModel):
    """Body sent to ``POST /v1-verify-permit``."""

    permit_token: str
    actor_id: str | None = None
    """Optional binding check -- server rejects on mismatch vs original evaluation."""
    action_type: str | None = None
    """Optional binding check -- server rejects on mismatch vs original evaluation."""
    traceparent: str | None = None

    model_config = ConfigDict(extra="forbid")


class VerifyPermitResponse(BaseModel):
    """Value-based response from ``POST /v1-verify-permit``.

    The server returns this envelope on every code path. Callers MUST inspect
    ``valid`` and ``outcome`` -- HTTP status is not authoritative.
    """

    valid: bool
    outcome: Literal["allow", "deny"]
    decision: Literal["allow"] | None = None
    """Present only when ``valid`` is true."""
    verify_error_code: VerifyErrorCode | None = None
    reason: str

    model_config = ConfigDict(extra="ignore")


# ── Error envelope ────────────────────────────────────────────────────


class ApiErrorBody(BaseModel):
    """Server error envelope used by non-verify endpoints and by auth paths."""

    error_code: str
    reason: str

    model_config = ConfigDict(extra="ignore")
