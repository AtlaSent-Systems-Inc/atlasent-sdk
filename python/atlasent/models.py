"""Pydantic models for AtlaSent API requests and responses.

Wire format (post 2026-04-30 contract reconciliation): every model
serializes to the canonical wire shape read by
``atlasent-api/supabase/functions/v1-{evaluate,verify-permit}/handler.ts``.

POST /v1-evaluate request:
    canonical: ``{ action_type, actor_id, context }``
    legacy:    ``{ action, agent, context, api_key }``
               (accepted with DeprecationWarning)

POST /v1-evaluate response:
    canonical: ``{ decision: "allow"|"deny"|"hold"|"escalate",
                   permit_token?, request_id?, expires_at?,
                   denial?: {reason, code}, ... }``
    legacy:    ``{ permitted: bool, decision_id, reason?, audit_hash?,
                   timestamp? }``
               (legacy server, transparently translated)

POST /v1-verify-permit request:
    canonical: ``{ permit_token, action_type?, actor_id? }``
    legacy:    ``{ decision_id, action, agent, context, api_key }``
               (accepted with DeprecationWarning)

POST /v1-verify-permit response:
    canonical: ``{ valid, outcome: "allow"|"deny",
                   verify_error_code?, reason? }``
    legacy:    ``{ verified, outcome, permit_hash, timestamp }``
               (legacy, transparently translated)

Construction with legacy keyword names (``action=``, ``agent=``,
``decision_id=``, ``api_key=``) keeps working but emits
``DeprecationWarning``. Reading legacy attributes on result objects
(``permitted``, ``decision_id``, ``verified``, ``permit_hash``,
``audit_hash``, ``timestamp``) is supported transparently and will
remain so for the duration of the deprecation window.
"""

from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, BaseModel, ConfigDict, Field, model_validator

# ── Rate-limit state (shared by evaluate + verify) ───────────────────


@dataclass(frozen=True)
class RateLimitState:
    """Per-key rate-limit state parsed from the server's
    ``X-RateLimit-*`` response headers.

    Present on every authenticated response (success and 429) when the
    server emits the headers. ``None`` on older deployments or on
    internal endpoints that skip per-key rate limiting.

    Consumers should check :attr:`remaining` and sleep until
    :attr:`reset_at` to preemptively back off before hitting a 429::

        result = client.evaluate(...)
        if result.rate_limit and result.rate_limit.remaining < 10:
            time.sleep(
                (result.rate_limit.reset_at - datetime.now(timezone.utc))
                .total_seconds()
            )

    Attributes:
        limit: Value of ``X-RateLimit-Limit`` — the per-minute budget.
        remaining: Value of ``X-RateLimit-Remaining`` — unused budget
            in the current window.
        reset_at: Parsed ``X-RateLimit-Reset`` — the UTC instant when
            the current window's counter zeroes. Accepts either a
            unix-seconds integer or an ISO 8601 string on the wire.
    """

    limit: int
    remaining: int
    reset_at: datetime


def _warn_legacy(label: str, mapping: str) -> None:
    """Emit a DeprecationWarning describing a single legacy input field.

    ``stacklevel=4`` lands on the caller of ``EvaluateRequest(...)`` /
    ``VerifyRequest(...)`` — the actionable site for fixing the code.
    """
    warnings.warn(
        f"AtlaSent SDK: legacy {label} ({mapping}) is deprecated and "
        "will be removed in a future major release.",
        DeprecationWarning,
        stacklevel=4,
    )


# ── Evaluate ──────────────────────────────────────────────────────────


class EvaluateRequest(BaseModel):
    """Payload sent to ``POST /v1-evaluate``.

    Accepts both the canonical input shape
    (``action_type=``, ``actor_id=``) and the legacy shape
    (``action=``, ``agent=``, ``api_key=``). Legacy field names emit
    ``DeprecationWarning`` on construction. Always serializes to the
    canonical wire (``{action_type, actor_id, context}``); ``api_key``
    is intentionally excluded — the server reads it from the
    ``Authorization`` header.
    """

    action_type: str = Field(
        ...,
        validation_alias=AliasChoices("action_type", "action"),
        description="Action being authorized (e.g. 'modify_patient_record').",
    )
    actor_id: str = Field(
        ...,
        validation_alias=AliasChoices("actor_id", "agent"),
        description="Identifier of the calling actor / agent.",
    )
    context: dict[str, Any] = Field(default_factory=dict)
    # Kept for backward-compat with code that constructs the request
    # directly. Excluded from wire serialization — the server reads the
    # API key from the Authorization header, never from the body.
    api_key: str = Field(default="", exclude=True)

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="before")
    @classmethod
    def _warn_on_legacy_input(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if "action" in data and "action_type" not in data:
            _warn_legacy("EvaluateRequest field", "action= -> action_type=")
        if "agent" in data and "actor_id" not in data:
            _warn_legacy("EvaluateRequest field", "agent= -> actor_id=")
        if data.get("api_key"):
            _warn_legacy(
                "EvaluateRequest field",
                "api_key= (request body) -> Authorization header (handled by client)",
            )
        return data


class EvaluateResult(BaseModel):
    """Response from ``POST /v1-evaluate``.

    Pydantic parses both the canonical handler.ts shape and the legacy
    ``{permitted, decision_id, ...}`` shape; legacy responses are
    translated to canonical fields via ``_accept_legacy_response``.

    In the fail-closed SDK you only receive this object when the
    decision is ``"allow"``. Anything else raises
    :class:`AtlaSentDenied` from the client.

    Canonical attributes:
        decision: Four-value decision (``"allow"|"deny"|"hold"|"escalate"``).
            Always ``"allow"`` when this object reaches user code via
            the fail-closed client; the other values may appear when
            constructing or parsing this model directly.
        permit_token: Opaque permit identifier. Pass to
            :meth:`AtlaSentClient.verify` to confirm the permit later.
        request_id: Server-side request identifier. Useful as an
            audit deep-link.
        expires_at: ISO 8601 timestamp at which the permit expires.
        denial: Populated on non-allow decisions. ``{"reason", "code"}``.
        rate_limit: Per-key rate-limit state from ``X-RateLimit-*``
            headers. ``None`` when the server didn't emit them.

    Legacy attributes (kept for backward-compat with existing readers,
    populated alongside their canonical counterparts):
        permitted: ``True`` iff ``decision == "allow"``.
        decision_id: Alias for :attr:`permit_token`.
        reason: Pulled from ``denial.reason`` when present.
        audit_hash: Legacy hash field. Empty under the canonical wire.
        timestamp: Legacy timestamp field. Empty under the canonical wire.
    """

    decision: Literal["allow", "deny", "hold", "escalate"] = "allow"
    permit_token: str = ""
    request_id: str = ""
    expires_at: str = ""
    denial: dict[str, Any] | None = None
    rate_limit: RateLimitState | None = None

    # Legacy fields. Populated by the model_validator (from canonical
    # `decision` / `permit_token` / `denial`) so existing readers like
    # ``result.permitted`` and ``result.decision_id`` keep working.
    permitted: bool = False
    decision_id: str = ""
    reason: str = ""
    audit_hash: str = ""
    timestamp: str = ""

    model_config = ConfigDict(
        populate_by_name=True,
        arbitrary_types_allowed=True,
        extra="ignore",
    )

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_response(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)

        # Legacy server shape: {permitted, decision_id, reason, audit_hash, timestamp}.
        # Translate to canonical {decision, permit_token, denial} so the rest of
        # the model populates uniformly.
        if "decision" not in out and isinstance(out.get("permitted"), bool):
            out["decision"] = "allow" if out["permitted"] else "deny"
        if "permit_token" not in out and "decision_id" in out:
            out["permit_token"] = out["decision_id"]
        if (
            "denial" not in out
            and out.get("decision") not in (None, "allow")
            and out.get("reason")
        ):
            out["denial"] = {"reason": out["reason"]}

        # Now mirror canonical → legacy so consumers reading either shape see
        # consistent values.
        decision = out.get("decision", "allow")
        if "permitted" not in out:
            out["permitted"] = decision == "allow"
        if "decision_id" not in out and out.get("permit_token"):
            out["decision_id"] = out["permit_token"]
        if "reason" not in out and isinstance(out.get("denial"), dict):
            out["reason"] = str(out["denial"].get("reason", ""))

        return out


# ── Verify ────────────────────────────────────────────────────────────


class VerifyRequest(BaseModel):
    """Payload sent to ``POST /v1-verify-permit``.

    Accepts both canonical input (``permit_token=``) and legacy
    (``decision_id=``, ``action=``, ``agent=``, ``api_key=``). Legacy
    field names emit ``DeprecationWarning``. Always serializes to the
    canonical wire (``{permit_token, action_type, actor_id}``);
    ``context`` and ``api_key`` are intentionally excluded — the
    server doesn't read them.
    """

    permit_token: str = Field(
        ...,
        validation_alias=AliasChoices("permit_token", "decision_id"),
        description="The permit_token returned by a prior /v1-evaluate call.",
    )
    action_type: str = Field(
        default="",
        validation_alias=AliasChoices("action_type", "action"),
        description="Optional cross-check — re-state the action.",
    )
    actor_id: str = Field(
        default="",
        validation_alias=AliasChoices("actor_id", "agent"),
        description="Optional cross-check — re-state the actor.",
    )
    # Legacy fields, excluded from wire serialization.
    context: dict[str, Any] = Field(default_factory=dict, exclude=True)
    api_key: str = Field(default="", exclude=True)

    model_config = ConfigDict(populate_by_name=True)

    @model_validator(mode="before")
    @classmethod
    def _warn_on_legacy_input(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        if "decision_id" in data and "permit_token" not in data:
            _warn_legacy("VerifyRequest field", "decision_id= -> permit_token=")
        if "action" in data and "action_type" not in data:
            _warn_legacy("VerifyRequest field", "action= -> action_type=")
        if "agent" in data and "actor_id" not in data:
            _warn_legacy("VerifyRequest field", "agent= -> actor_id=")
        if data.get("api_key"):
            _warn_legacy(
                "VerifyRequest field",
                "api_key= (request body) -> Authorization header (handled by client)",
            )
        if data.get("context"):
            _warn_legacy(
                "VerifyRequest field",
                "context= (request body) is no longer cross-checked by the server",
            )
        return data


class VerifyResult(BaseModel):
    """Response from ``POST /v1-verify-permit``.

    Parses both the canonical handler.ts shape
    (``{valid, outcome, verify_error_code, reason}``) and the legacy
    shape (``{verified, outcome, permit_hash, timestamp}``); legacy
    responses are translated by ``_accept_legacy_response``.

    Canonical attributes:
        valid: ``True`` iff the permit is still valid, un-expired,
            un-revoked, and un-consumed.
        outcome: Server-side ``"allow"`` or ``"deny"``.
        verify_error_code: Stable code populated when ``outcome=="deny"``
            (e.g. ``"PERMIT_EXPIRED"``, ``"PERMIT_ALREADY_USED"``).
        reason: Human-readable explanation. Safe to surface to operators.
        rate_limit: Per-key rate-limit state from ``X-RateLimit-*``
            headers. ``None`` when the server didn't emit them.

    Legacy attributes:
        verified: Alias for :attr:`valid`.
        permit_hash: Legacy verification hash. Empty under canonical wire.
        timestamp: Legacy timestamp. Empty under canonical wire.
    """

    valid: bool = False
    outcome: str = ""
    verify_error_code: str | None = None
    reason: str = ""
    rate_limit: RateLimitState | None = None

    # Legacy passthrough.
    verified: bool = False
    permit_hash: str = ""
    timestamp: str = ""

    model_config = ConfigDict(
        populate_by_name=True,
        arbitrary_types_allowed=True,
        extra="ignore",
    )

    @model_validator(mode="before")
    @classmethod
    def _accept_legacy_response(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        out = dict(data)

        # Legacy server shape: {verified, outcome, permit_hash, timestamp}.
        if "valid" not in out and isinstance(out.get("verified"), bool):
            out["valid"] = out["verified"]
        # Mirror canonical → legacy so existing `result.verified` keeps working.
        if "verified" not in out and isinstance(out.get("valid"), bool):
            out["verified"] = out["valid"]

        return out


# ── Key self-introspection ────────────────────────────────────────────


class ApiKeySelfResult(BaseModel):
    """Successful response from ``GET /v1-api-key-self``.

    Self-introspection of the API key this client was constructed with.
    Never includes the raw key or its hash — introspection is
    intentionally read-only and safe to surface in operator dashboards.

    Useful for:
        * ``IP_NOT_ALLOWED`` debugging — :attr:`client_ip` is the IP the
          server observed (first hop of X-Forwarded-For).
        * Proactive expiry warnings — :attr:`expires_at` is the
          server-stored expiry (``None`` means the key does not
          auto-expire).
        * Verifying scopes before attempting a scope-gated action.
        * "Which key am I?" in multi-tenant dashboards.

    Attributes:
        key_id: Server-side UUID of the ``api_keys`` row for this key.
        organization_id: Organization the key belongs to.
        environment: ``"live"`` / ``"test"`` (or any future environment
            label the server introduces).
        scopes: Granted scopes (e.g. ``["evaluate", "audit.read"]``).
        allowed_cidrs: Per-key IP allowlist as CIDR strings, or
            ``None`` when the key is unrestricted.
        rate_limit_per_minute: Server-enforced per-minute rate limit.
        client_ip: Client IP as the server observed it.
        expires_at: Server-stored expiry; ``None`` means no auto-expire.
        rate_limit: Per-key rate-limit state from ``X-RateLimit-*``
            headers on this response. ``None`` when the server didn't
            emit them.
    """

    key_id: str
    organization_id: str
    environment: str
    scopes: list[str] = Field(default_factory=list)
    allowed_cidrs: list[str] | None = None
    rate_limit_per_minute: int
    client_ip: str | None = None
    expires_at: str | None = None
    rate_limit: RateLimitState | None = None

    model_config = ConfigDict(populate_by_name=True, arbitrary_types_allowed=True)


# ── Gate (convenience) ────────────────────────────────────────────────


class GateResult(BaseModel):
    """Combined result from :meth:`AtlaSentClient.gate`.

    Contains both the evaluation and verification results so callers
    have full audit context in one object.
    """

    evaluation: EvaluateResult
    verification: VerifyResult


# ── Authorize (public top-level API) ─────────────────────────────────


@dataclass(frozen=True)
class Permit:
    """Successful return value from :func:`atlasent.protect` — the
    action is authorized end-to-end (evaluate passed AND the resulting
    permit verified).

    Attributes:
        permit_id: Opaque permit / decision identifier.
        permit_hash: Verification hash bound to the permit.
        audit_hash: Hash-chained audit-trail entry (21 CFR Part 11).
        reason: Human-readable explanation from the policy engine.
        timestamp: ISO 8601 timestamp of the verification.
    """

    permit_id: str
    permit_hash: str
    audit_hash: str
    reason: str = ""
    timestamp: str = ""


@dataclass
class AuthorizationResult:
    """Result of an :func:`atlasent.authorize` call.

    Check :attr:`permitted` to decide whether to proceed.

    Attributes:
        permitted: ``True`` if the action is authorized and verified.
        agent: The agent identifier passed to ``authorize``.
        action: The action name passed to ``authorize``.
        context: The context dict passed to ``authorize``.
        reason: Human-readable explanation from the policy engine.
        permit_token: Opaque decision identifier for audit lookup.
        audit_hash: Hash-chained audit trail entry.
        permit_hash: Verification hash bound to the permit.
        verified: ``True`` if the permit was server-verified end-to-end.
        timestamp: ISO 8601 timestamp.
        raw: The raw JSON response body from the API.
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
        return self.permitted


# ── Revoke permit ─────────────────────────────────────────────────────


class RevokePermitResult(BaseModel):
    """Result of :meth:`AtlaSentClient.revoke_permit`."""

    revoked: bool
    permit_id: str = Field(alias="decision_id")
    revoked_at: str | None = None
    audit_hash: str | None = None
    rate_limit: RateLimitState | None = None

    model_config = ConfigDict(populate_by_name=True)


# ── Streaming evaluate events ─────────────────────────────────────────


class StreamDecisionEvent(BaseModel):
    """A policy decision emitted mid-stream by ``/v1-evaluate-stream``."""

    type: Literal["decision"] = "decision"
    decision: str
    permit_id: str = Field(alias="decision_id", default="")
    reason: str = ""
    audit_hash: str = ""
    timestamp: str = ""
    is_final: bool = False

    @classmethod
    def from_wire(cls, data: dict[str, Any]) -> StreamDecisionEvent:  # noqa: D401
        permitted = data.get("permitted", True)
        return cls(
            decision="ALLOW" if permitted else "DENY",
            decision_id=data.get("decision_id", ""),
            reason=data.get("reason", ""),
            audit_hash=data.get("audit_hash", ""),
            timestamp=data.get("timestamp", ""),
            is_final=bool(data.get("is_final", False)),
        )

    model_config = ConfigDict(populate_by_name=True)


class StreamProgressEvent(BaseModel):
    """An intermediate progress hint emitted before the final decision."""

    type: Literal["progress"] = "progress"
    stage: str = ""
    model_config = ConfigDict(extra="allow", populate_by_name=True)


StreamEvent = Annotated[
    StreamDecisionEvent | StreamProgressEvent,
    Field(discriminator="type"),
]
