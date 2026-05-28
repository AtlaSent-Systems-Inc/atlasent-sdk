"""Synchronous AtlaSent API client (httpx-based)."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
import uuid
import warnings
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlparse

import httpx

from ._version import __version__
from .access_governance_log import AccessGovernanceLogClient
from .approval_artifact import ApprovalReference
from .audit import AuditEventsResult, AuditExportResult
from .evidence_bundle import EvidenceBundlesClient
from .exceptions import (
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    PermissionDeniedError,
    RateLimitError,
    _normalize_permit_outcome,
)
from .governance_agents import (
    GovernanceAgent,
    GovernanceAgentEvaluation,
    GovernanceAgentFinding,
    ListGovernanceAgentsResult,
    ListGovernanceEvaluationsResult,
    ListGovernanceFindingsResult,
)
from .hitl import (
    HitlApprovalsResult,
    HitlChainResult,
    HitlCreateRequest,
    HitlEscalation,
    HitlEscalationResult,
    HitlStatus,
    ListHitlEscalationsResult,
)
from .models import (
    ApiKeySelfResult,
    AuthorizationResult,
    ConstraintTrace,
    EvaluatePreflightResult,
    EvaluateRequest,
    EvaluateResult,
    GateResult,
    GetPermitResult,
    ListPermitsResult,
    Permit,
    PermitRecord,
    PermitVerifyEvidence,
    RateLimitState,
    ReplayResponse,
    ReplayVarianceKind,
    RevokePermitByIdResult,
    RevokePermitResult,
    VerifyPermitByIdResult,
    VerifyRequest,
    VerifyResult,
)
from .sso_client import SsoClient

if TYPE_CHECKING:
    from .cache import TTLCache

logger = logging.getLogger("atlasent")

DEFAULT_BASE_URL = "https://api.atlasent.io"
DEFAULT_TIMEOUT = 10
# Retry schedule parity with the TypeScript SDK:
#   4 total attempts (1 initial + 3 retries), delays 2 s → 4 s → 8 s
#   (capped at 16 s) via the exponential formula:
#   delay = min(16, retry_backoff * 2**attempt)
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_BACKOFF = 2.0
_RETRY_MAX_DELAY = 16.0


def _compute_execution_hash(payload: dict) -> str:
    """SHA-256 of RFC-8785-style canonical JSON (keys sorted recursively).

    Used as ``execution_hash`` on the permit-consume (verify) request so
    the server can validate the evaluate payload was not tampered with
    between evaluate and consume.

    P1-5: Required by the API for production permits as of 2026-05-14.
    """

    def _sort_deep(obj):
        if isinstance(obj, dict):
            return {k: _sort_deep(v) for k, v in sorted(obj.items())}
        if isinstance(obj, list):
            return [_sort_deep(i) for i in obj]
        return obj

    canonical = json.dumps(
        _sort_deep(payload), separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


# API-key prefix contract per atlasent-api/supabase/functions/_shared/auth.ts:
#   "ask_live_<entropy>" — production keys
#   "ask_test_<entropy>" — non-production keys
# Validated client-side so a mis-pasted key (with whitespace, quotes,
# or a leftover wrapping char) trips loudly at construction rather
# than yielding a 401 mid-conversation. The character class matches
# what atlasent-api accepts; widen here only if the server widens
# first.
_API_KEY_PATTERN = re.compile(r"^ask_(?:live|test)_[A-Za-z0-9_-]+$")
_ACTION_TYPE_RE = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")


def _validate_api_key(api_key: str) -> str:
    """Reject obviously-malformed API keys at client init.

    Returns the trimmed key on accept; raises ``ValueError`` on
    reject. Never echoes the key into the error message — only the
    first 8 characters of any non-matching value, so a paste accident
    that copies the right side of the key doesn't surface in stderr.
    """
    if not isinstance(api_key, str) or not api_key:
        raise ValueError("AtlaSent api_key is required")
    if not _API_KEY_PATTERN.match(api_key):
        head = api_key[:8] if api_key else ""
        raise ValueError(
            f"AtlaSent api_key does not match expected shape "
            f"`ask_(live|test)_<entropy>` (got prefix={head!r}). "
            "Check for whitespace, quotes, or trailing characters."
        )
    return api_key


def _redact_token(token: str) -> str:
    """Render a permit/decision token safe to log.

    Returns ``"…<last 6>"`` so log lines correlate against the
    server-side audit trail without leaking enough material to replay
    a permit. ``""`` and short strings render as ``"…"``.
    """
    if not token:
        return "…"
    return "…" + token[-6:]


def _enforce_tls(base_url: str) -> str:
    """Reject non-TLS base URLs unless the dev escape hatch is set.

    `ATLASENT_ALLOW_INSECURE_HTTP=1` permits ``http://`` for local
    fixtures and unit tests that mock httpx — production callers never
    set this. Returns the URL unchanged on accept; raises ``ValueError``
    on reject.
    """
    if os.getenv("ATLASENT_ALLOW_INSECURE_HTTP") == "1":
        return base_url
    parsed = urlparse(base_url)
    if parsed.scheme and parsed.scheme != "https":
        raise ValueError(
            f"AtlaSent base_url must use https:// (got scheme={parsed.scheme!r}). "
            "For local development, set ATLASENT_ALLOW_INSECURE_HTTP=1."
        )
    return base_url


class AtlaSentClient:
    """Synchronous client for the AtlaSent authorization API.

    The client is **fail-closed**: any failure to confirm authorization
    raises an exception, so no action can proceed without an explicit
    permit.

    Args:
        api_key: Your AtlaSent API key (required).
        anon_key: An anonymous / public key for client-side contexts.
        base_url: Override the API base URL.
        timeout: HTTP request timeout in seconds.
        max_retries: Retries on transient errors (5xx, timeouts).
        retry_backoff: Base backoff in seconds (doubles each retry).
        cache: Optional :class:`~atlasent.cache.TTLCache` for caching
            evaluate results and avoiding redundant API calls.

    Usage::

        from atlasent import AtlaSentClient

        client = AtlaSentClient(api_key="ask_live_...")
        result = client.gate("modify_patient_record", "agent-1",
                             {"patient_id": "PT-001"})
        print(result.verification.permit_hash)

    Supports the context-manager protocol::

        with AtlaSentClient(api_key="ask_live_...") as client:
            result = client.evaluate("read_data", "agent-1")
    """

    def __init__(
        self,
        api_key: str,
        *,
        anon_key: str = "",
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_backoff: float = DEFAULT_RETRY_BACKOFF,
        cache: TTLCache | None = None,
    ) -> None:
        self._api_key = _validate_api_key(api_key)
        self._anon_key = anon_key
        self._base_url = _enforce_tls(base_url).rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff
        self._cache = cache
        self._client = httpx.Client(
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent": f"atlasent-python/{__version__}",
                # ADR-025: declare the wire-protocol version we were
                # built against. Runtime serves this version's response
                # shape; older versions outside the compatibility window
                # get 426 Upgrade Required.
                "X-AtlaSent-Protocol-Version": "1",
            },
            timeout=self._timeout,
        )
        self.sso = SsoClient(self)
        self.access_governance_log = AccessGovernanceLogClient(self)
        self.evidence_bundles = EvidenceBundlesClient(self)

    # ── properties ────────────────────────────────────────────

    @property
    def api_key(self) -> str:
        return self._api_key

    @property
    def base_url(self) -> str:
        return self._base_url

    # ── public API ───────────────────────────────────────────

    def evaluate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
        *,
        resource_id: str | None = None,
        amount: float | None = None,
        approval: ApprovalReference | dict[str, Any] | None = None,
        require_approval: bool | None = None,
    ) -> EvaluateResult:
        ctx = context or {}
        if isinstance(approval, dict):
            approval = ApprovalReference.model_validate(approval)

        if self._cache is not None:
            from .cache import TTLCache

            cache_key = TTLCache.make_key(action_type, actor_id, ctx)
            cached = self._cache.get(cache_key)
            if cached is not None:
                logger.debug("evaluate cache hit for %s", cache_key)
                return cached

        req = EvaluateRequest(
            action_type=action_type,
            actor_id=actor_id,
            context=ctx,
            resource_id=resource_id,
            amount=amount,
            approval=approval,
            require_approval=require_approval,
        )
        logger.debug("evaluate action=%r actor=%r", action_type, actor_id)
        data, rate_limit, request_id = self._post(
            "/v1-evaluate", req.model_dump(by_alias=True, exclude_none=True)
        )

        decision = data.get("decision")
        if decision is None and isinstance(data.get("permitted"), bool):
            decision = "allow" if data["permitted"] else "deny"
        permit_token_raw = data.get("permit_token") or data.get("decision_id")
        if decision not in ("allow", "deny", "hold", "escalate") or not isinstance(
            permit_token_raw, (str, type(None))
        ):
            raise AtlaSentError(
                "Malformed /v1-evaluate response: missing or invalid "
                "`decision` (or legacy `permitted`/`decision_id`)",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )

        if decision != "allow":
            denial = data.get("denial") if isinstance(data.get("denial"), dict) else {}
            reason = denial.get("reason") if denial else data.get("reason", "")
            raise AtlaSentDenied(
                decision=decision,
                permit_token=permit_token_raw or "",
                reason=reason or "",
                request_id=request_id,
                response_body=data,
            )

        if not permit_token_raw:
            raise AtlaSentError(
                "Malformed /v1-evaluate response: decision='allow' "
                "but no permit_token (or legacy decision_id)",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )

        result = EvaluateResult.model_validate(data)
        result.rate_limit = rate_limit
        logger.info(
            "evaluate permitted action=%r actor=%r token=%s",
            action_type,
            actor_id,
            _redact_token(result.permit_token),
        )

        if self._cache is not None:
            self._cache.put(cache_key, result)

        return result

    def evaluate_preflight(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> EvaluatePreflightResult:
        ctx = context or {}
        req = EvaluateRequest(
            action_type=action_type,
            actor_id=actor_id,
            context=ctx,
        )
        logger.debug("evaluate_preflight action=%r actor=%r", action_type, actor_id)
        data, rate_limit, request_id = self._post(
            "/v1-evaluate",
            req.model_dump(by_alias=True, exclude_none=True),
            params={"include": "constraint_trace"},
        )

        decision = data.get("decision")
        if decision is None and isinstance(data.get("permitted"), bool):
            decision = "allow" if data["permitted"] else "deny"
        if decision not in ("allow", "deny", "hold", "escalate"):
            raise AtlaSentError(
                "Malformed /v1-evaluate response: missing or invalid "
                "`decision` (or legacy `permitted`)",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )

        evaluation = EvaluateResult.model_validate(data)
        evaluation.rate_limit = rate_limit

        trace_raw = data.get("constraint_trace")
        constraint_trace: ConstraintTrace | None = None
        if isinstance(trace_raw, dict):
            constraint_trace = ConstraintTrace.model_validate(trace_raw)

        logger.info(
            "evaluate_preflight decision=%s action=%r actor=%r trace=%s",
            evaluation.decision,
            action_type,
            actor_id,
            "present" if constraint_trace is not None else "absent",
        )
        return EvaluatePreflightResult(
            evaluation=evaluation, constraint_trace=constraint_trace
        )

    def verify(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context: dict[str, Any] | None = None,
        *,
        require_approval: bool | None = None,
        environment: str | None = None,
        execution_hash: str | None = None,
    ) -> VerifyResult:
        warnings.warn(
            "AtlaSentClient.verify() is deprecated. Use verify_permit_by_id() "
            "for the canonical REST surface; it returns the unified "
            "verification envelope (valid/verification_type/reason/verified_at/"
            "evidence) plus the full PermitRecord. Will be removed in v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        del context
        req = VerifyRequest(
            permit_token=permit_token,
            action_type=action_type,
            actor_id=actor_id,
            require_approval=require_approval,
            environment=environment,
            execution_hash=execution_hash if execution_hash else None,
        )
        logger.debug("verify token=%s", _redact_token(permit_token))
        data, rate_limit, request_id = self._post(
            "/v1-verify-permit", req.model_dump(by_alias=True, exclude_none=True)
        )
        if not isinstance(data.get("valid"), bool) and not isinstance(
            data.get("verified"), bool
        ):
            raise AtlaSentError(
                "Malformed /v1-verify-permit response: missing `valid` "
                "(or legacy `verified`)",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )
        result = VerifyResult.model_validate(data)
        result.rate_limit = rate_limit
        logger.info(
            "verify token=%s valid=%s", _redact_token(permit_token), result.valid
        )
        return result

    def protect(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
    ) -> Permit:
        if not _ACTION_TYPE_RE.match(action):
            raise AtlaSentError(
                (
                    "action must be in dot-notation format "
                    '(e.g. "production.deploy"). '
                    f"Got: {action!r}"
                ),
                code="bad_request",
            )
        ctx = context or {}
        try:
            eval_result = self.evaluate(action, agent, ctx)
        except AtlaSentDenied as exc:
            audit_hash = ""
            if exc.response_body is not None:
                candidate = exc.response_body.get("audit_hash")
                if isinstance(candidate, str):
                    audit_hash = candidate
            raise AtlaSentDeniedError(
                decision="deny",
                evaluation_id=exc.permit_token,
                reason=exc.reason,
                audit_hash=audit_hash,
            ) from None

        _ctx_env = (
            ctx.get("environment") if isinstance(ctx.get("environment"), str) else None
        )
        if not _ctx_env:
            raise AtlaSentError(
                "context.environment is required. Pass the environment where this "
                "action executes (for example, 'production' or 'staging').",
                code="bad_request",
            )

        _eval_payload: dict[str, Any] = {
            "action_type": action,
            "actor_id": agent,
            "context": ctx,
        }
        _execution_hash = _compute_execution_hash(_eval_payload)

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            verify_result = self.verify(
                eval_result.permit_token,
                action,
                agent,
                ctx,
                environment=_ctx_env,
                execution_hash=_execution_hash,
            )

        if not verify_result.valid:
            raise AtlaSentDeniedError(
                decision="deny",
                evaluation_id=eval_result.permit_token,
                reason=f"Permit failed verification ({verify_result.outcome})",
                audit_hash=eval_result.audit_hash,
                outcome=_normalize_permit_outcome(verify_result.outcome),
            )

        return Permit(
            permit_id=eval_result.permit_token,
            permit_hash=verify_result.permit_hash,
            audit_hash=eval_result.audit_hash,
            reason=eval_result.reason,
            timestamp=verify_result.timestamp,
            permit_expires_at=eval_result.expires_at or None,
        )

    def gate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> GateResult:
        warnings.warn(
            "AtlaSentClient.gate() is deprecated. Use protect() for "
            "fail-closed execution or evaluate() + verify() to inspect "
            "the decision and verify separately. Will be removed in v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        ctx = context or {}
        eval_result = self.evaluate(action_type, actor_id, ctx)
        verify_result = self.verify(
            eval_result.permit_token, action_type, actor_id, ctx
        )
        return GateResult(evaluation=eval_result, verification=verify_result)

    def authorize(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
        verify: bool = True,
        raise_on_deny: bool = False,
    ) -> AuthorizationResult:
        warnings.warn(
            "AtlaSentClient.authorize() is deprecated. Use protect() for "
            "fail-closed execution (recommended) or evaluate() to inspect "
            "the four-value decision. Will be removed in v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        ctx = context or {}
        try:
            eval_result = self.evaluate(action, agent, ctx)
        except AtlaSentDenied as exc:
            if raise_on_deny:
                raise PermissionDeniedError(
                    decision=exc.decision,
                    permit_token=exc.permit_token,
                    reason=exc.reason,
                    response_body=exc.response_body,
                ) from None
            return AuthorizationResult(
                permitted=False,
                agent=agent,
                action=action,
                context=dict(ctx),
                reason=exc.reason,
                permit_token=exc.permit_token,
                raw=exc.response_body or {},
            )

        permit_hash = ""
        verified = False
        if verify:
            verify_result = self.verify(eval_result.permit_token, action, agent, ctx)
            permit_hash = verify_result.permit_hash
            verified = verify_result.valid

        return AuthorizationResult(
            permitted=True,
            agent=agent,
            action=action,
            context=dict(ctx),
            reason=eval_result.reason,
            permit_token=eval_result.permit_token,
            audit_hash=eval_result.audit_hash,
            permit_hash=permit_hash,
            verified=verified,
            timestamp=eval_result.timestamp,
            raw=eval_result.model_dump(by_alias=True),
        )

    # ── lifecycle ────────────────────────────────────────────────

    def close(self) -> None:
        self._client.close()
        logger.debug("AtlaSentClient closed")

    def __enter__(self) -> AtlaSentClient:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:  # noqa: ANN001
        self.close()

    def key_self(self) -> ApiKeySelfResult:
        logger.debug("key_self")
        data, rate_limit, request_id = self._get("/v1-api-key-self")

        if not isinstance(data.get("key_id"), str) or not isinstance(
            data.get("organization_id"), str
        ):
            raise AtlaSentError(
                "Malformed /v1-api-key-self response: missing "
                "`key_id` or `organization_id`",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )

        return ApiKeySelfResult.model_validate({**data, "rate_limit": rate_limit})

    def revoke_permit(
        self,
        permit_id: str,
        *,
        reason: str | None = None,
    ) -> RevokePermitResult:
        warnings.warn(
            "AtlaSentClient.revoke_permit() is deprecated. Use "
            "revoke_permit_by_id() for the canonical REST surface; it "
            "returns the full updated PermitRecord with revoked_at / "
            "revoked_by / revoke_reason populated. Will be removed in v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        payload = {
            "decision_id": permit_id,
            "reason": reason or "",
            "api_key": self._api_key,
        }
        logger.debug("revoke_permit permit_id=%s", _redact_token(permit_id))
        data, rate_limit, request_id = self._post("/v1-revoke-permit", payload)

        if not isinstance(data.get("revoked"), bool) or not isinstance(
            data.get("decision_id"), str
        ):
            raise AtlaSentError(
                "Malformed /v1-revoke-permit response: "
                "missing `revoked` or `decision_id`",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )

        result = RevokePermitResult.model_validate(data)
        result.rate_limit = rate_limit
        return result

    def revoke_permit_by_id(
        self,
        permit_id: str,
        *,
        reason: str | None = None,
    ) -> RevokePermitByIdResult:
        if not permit_id:
            raise AtlaSentError("permit_id is required", code="bad_request")
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        path = f"/v1/permits/{quote(permit_id, safe='')}/revoke"
        data, rate_limit, _ = self._post(path, body)
        return RevokePermitByIdResult(
            permit=PermitRecord.model_validate(data),
            rate_limit=rate_limit,
        )

    def verify_permit_by_id(self, permit_id: str) -> VerifyPermitByIdResult:
        if not permit_id:
            raise AtlaSentError("permit_id is required", code="bad_request")
        path = f"/v1/permits/{quote(permit_id, safe='')}/verify"
        data, rate_limit, request_id = self._post(path, {})
        envelope_keys = {
            "valid",
            "verification_type",
            "reason",
            "verified_at",
            "evidence",
        }
        permit_row = {k: v for k, v in data.items() if k not in envelope_keys}
        if "valid" not in data or "evidence" not in data:
            raise AtlaSentError(
                (
                    "Malformed /v1/permits/{id}/verify response: "
                    "missing canonical envelope fields"
                ),
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )
        return VerifyPermitByIdResult(
            valid=bool(data["valid"]),
            verification_type="permit",
            reason=data.get("reason"),
            verified_at=str(data["verified_at"]),
            evidence=PermitVerifyEvidence.model_validate(data["evidence"]),
            permit=PermitRecord.model_validate(permit_row),
            rate_limit=rate_limit,
        )

    def get_permit(self, permit_id: str) -> GetPermitResult:
        if not permit_id:
            raise AtlaSentError("permit_id is required", code="bad_request")
        path = f"/v1/permits/{quote(permit_id, safe='')}"
        data, rate_limit, _ = self._get(path)
        return GetPermitResult(
            permit=PermitRecord.model_validate(data),
            rate_limit=rate_limit,
        )

    def list_permits(
        self,
        *,
        status: str | None = None,
        actor_id: str | None = None,
        action_type: str | None = None,
        from_: str | None = None,
        to: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> ListPermitsResult:
        params: dict[str, str] = {}
        if status is not None:
            params["status"] = status
        if actor_id is not None:
            params["actor_id"] = actor_id
        if action_type is not None:
            params["action_type"] = action_type
        if from_ is not None:
            params["from"] = from_
        if to is not None:
            params["to"] = to
        if limit is not None:
            params["limit"] = str(limit)
        if cursor is not None:
            params["cursor"] = cursor

        data, rate_limit, request_id = self._get("/v1/permits", params=params or None)
        permits_raw = data.get("permits")
        if not isinstance(permits_raw, list):
            raise AtlaSentError(
                "Malformed /v1/permits response: missing `permits` array",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )
        permits = [PermitRecord.model_validate(p) for p in permits_raw]
        total = data.get("total")
        return ListPermitsResult(
            permits=permits,
            total=total if isinstance(total, int) else len(permits),
            next_cursor=data.get("next_cursor"),
            rate_limit=rate_limit,
        )

    def list_audit_events(
        self,
        *,
        types: str | None = None,
        actor_id: str | None = None,
        from_: str | None = None,
        to: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> AuditEventsResult:
        params: dict[str, str] = {}
        if types:
            params["types"] = types
        if actor_id:
            params["actor_id"] = actor_id
        if from_:
            params["from"] = from_
        if to:
            params["to"] = to
        if limit is not None:
            params["limit"] = str(limit)
        if cursor:
            params["cursor"] = cursor

        logger.debug("list_audit_events params=%r", params)
        data, rate_limit, request_id = self._request(
            "GET", "/v1-audit/events", None, params=params
        )

        if not isinstance(data.get("events"), list) or not isinstance(
            data.get("total"), int
        ):
            raise AtlaSentError(
                "Malformed /v1-audit/events response: missing `events` or `total`",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )

        return AuditEventsResult.model_validate({**data, "rate_limit": rate_limit})

    def create_audit_export(
        self,
        *,
        types: str | None = None,
        actor_id: str | None = None,
        from_: str | None = None,
        to: str | None = None,
    ) -> AuditExportResult:
        payload: dict[str, Any] = {}
        if types:
            payload["types"] = types
        if actor_id:
            payload["actor_id"] = actor_id
        if from_:
            payload["from"] = from_
        if to:
            payload["to"] = to

        logger.debug("create_audit_export filter=%r", payload)
        data, rate_limit, request_id = self._post("/v1-audit/exports", payload)

        if (
            not isinstance(data.get("export_id"), str)
            or not isinstance(data.get("chain_head_hash"), str)
            or not isinstance(data.get("events"), list)
        ):
            raise AtlaSentError(
                "Malformed /v1-audit/exports response: missing "
                "`export_id`, `chain_head_hash`, or `events`",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )

        return AuditExportResult(bundle=data, rate_limit=rate_limit)

    def list_governance_agents(self) -> ListGovernanceAgentsResult:
        """List advisory governance agents registered for this org
        (``GET /v1/governance/agents``).

        Every returned agent has ``authority_class == "advisory"`` and
        ``can_authorize == False`` -- structural invariants enforced by the
        runtime DB, not just convention.

        Raises:
            AtlaSentError: Network error, timeout, or malformed payload.
            RateLimitError: HTTP 429.
        """
        logger.debug("list_governance_agents")
        data, rate_limit, request_id = self._get("/v1/governance/agents")

        agents_raw = data.get("agents")
        if not isinstance(agents_raw, list):
            raise AtlaSentError(
                "Malformed /v1/governance/agents response: missing `agents` array",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )
        return ListGovernanceAgentsResult(
            agents=[GovernanceAgent.model_validate(a) for a in agents_raw],
            rate_limit=rate_limit,
        )

    def list_governance_findings(
        self,
        *,
        change_id: str,
        agent_slug: str | None = None,
    ) -> ListGovernanceFindingsResult:
        """List advisory findings produced against one governed change
        (``GET /v1/governance/findings?change_id=...``).

        All returned findings have ``can_authorize == False`` -- enforced
        by a CHECK constraint on the runtime DB; no finding can ever
        satisfy a gate.

        Args:
            change_id: The governed-change UUID to query against.
            agent_slug: Optional filter to a single agent's findings.

        Raises:
            AtlaSentError: Network error, timeout, or malformed payload.
            RateLimitError: HTTP 429.
        """
        if not change_id:
            raise AtlaSentError("change_id is required", code="bad_request")
        params: dict[str, str] = {"change_id": change_id}
        if agent_slug is not None:
            params["agent_slug"] = agent_slug

        logger.debug("list_governance_findings change_id=%r", change_id)
        data, rate_limit, request_id = self._get(
            "/v1/governance/findings", params=params
        )

        findings_raw = data.get("findings")
        if not isinstance(findings_raw, list):
            raise AtlaSentError(
                "Malformed /v1/governance/findings response: missing `findings` array",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )
        return ListGovernanceFindingsResult(
            findings=[GovernanceAgentFinding.model_validate(f) for f in findings_raw],
            rate_limit=rate_limit,
        )

    def list_governance_evaluations(
        self,
        *,
        change_id: str,
        agent_slug: str | None = None,
    ) -> ListGovernanceEvaluationsResult:
        """List agent run records for a governed change
        (``GET /v1/governance/evaluations?change_id=...``).

        Includes completed, failed, and timed-out runs. The same
        (agent_slug, agent_version, input_hash) combination may produce
        multiple rows -- the runtime DB does not dedupe.

        Args:
            change_id: The governed-change UUID to query against.
            agent_slug: Optional filter to one agent's runs.

        Raises:
            AtlaSentError: Network error, timeout, or malformed payload.
            RateLimitError: HTTP 429.
        """
        if not change_id:
            raise AtlaSentError("change_id is required", code="bad_request")
        params: dict[str, str] = {"change_id": change_id}
        if agent_slug is not None:
            params["agent_slug"] = agent_slug

        logger.debug("list_governance_evaluations change_id=%r", change_id)
        data, rate_limit, request_id = self._get(
            "/v1/governance/evaluations", params=params
        )

        evals_raw = data.get("evaluations")
        if not isinstance(evals_raw, list):
            raise AtlaSentError(
                "Malformed /v1/governance/evaluations response: "
                "missing `evaluations` array",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )
        return ListGovernanceEvaluationsResult(
            evaluations=[
                GovernanceAgentEvaluation.model_validate(e) for e in evals_raw
            ],
            rate_limit=rate_limit,
        )

    # ── Decision replay (ADR-015 Phase C parity runtime) ────────────────
    #
    # Sync mirror of AsyncAtlaSentClient.replay(). Side-effect-free
    # server-side: replaying does not write to the audit chain or mint
    # a permit (ADR-016 ``mode: "replay"`` sentinel).
    #
    # Wire-variance → SDK-canonical mapping is kept identical to the
    # async client to keep contract conformance vectors valid against
    # both runtimes. See ``ReplayResponse`` in ``models`` for the
    # 7-value variance union and its interpretation.

    def replay(self, *, evaluation_id: str) -> ReplayResponse:
        """Re-evaluate a recorded decision against its originally-pinned
        bundle and engine version. Side-effect-free server-side.

        ``409 replay_not_eligible`` responses are surfaced as a
        ``ReplayResponse`` with ``variance_kind`` of ``ENGINE_DRIFT``
        or ``BUNDLE_MISSING`` rather than raising — callers can branch
        on the variance kind without try/except plumbing.

        Args:
            evaluation_id: The UUID of the recorded decision to replay.

        Raises:
            AtlaSentError: Network / transport failure, non-409 HTTP
                error, or malformed response payload.
        """
        path = f"/v1/decisions/{quote(evaluation_id, safe='')}/replay"
        try:
            data, rate_limit, _ = self._post(path, {})
        except AtlaSentError as err:
            if err.status_code == 409:
                msg = str(err).lower()
                variance_kind: ReplayVarianceKind = (
                    "BUNDLE_MISSING" if "bundle" in msg else "ENGINE_DRIFT"
                )
                return ReplayResponse(
                    decision_id=evaluation_id,
                    variance_kind=variance_kind,
                    original_decision="deny",
                    accepts_replay=False,
                    replayed_at=datetime.now(timezone.utc).isoformat(),
                    rate_limit=None,
                )
            raise
        variance_map: dict[str, str] = {
            "NONE": "NONE",
            "DECISION_CHANGED": "POLICY_DRIFT",
            "ENVELOPE_DRIFT": "ENVELOPE_DRIFT",
            "CHAIN_TAMPER": "CHAIN_TAMPER",
            "BUNDLE_MISSING": "BUNDLE_MISSING",
            "ENGINE_DRIFT": "ENGINE_DRIFT",
        }
        raw_variance = data.get("variance", "")
        vk: ReplayVarianceKind = variance_map.get(raw_variance, "NONE")
        replay_dec = data.get("replay_decision")
        return ReplayResponse(
            decision_id=data.get("decision_id", evaluation_id),
            variance_kind=vk,
            original_decision=(data.get("original_decision") or "deny").lower(),
            original_deny_code=data.get("original_deny_code"),
            replayed_decision=replay_dec.lower() if replay_dec else None,
            replayed_deny_code=data.get("replay_deny_code"),
            engine_version=data.get("engine_version"),
            engine_version_kind=data.get("engine_version_kind"),
            accepts_replay=bool(data.get("accepts_replay", True)),
            envelope_verification=data.get("envelope_verification"),
            replayed_at=data.get("replayed_at")
            or datetime.now(timezone.utc).isoformat(),
            rate_limit=rate_limit,
        )

    # ── internals ─────────────────────────────────────────────────────

    def _post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        return self._request("POST", path, payload, params=params)

    def _get(
        self,
        path: str,
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        return self._request("GET", path, None, params=params)

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        url = f"{self._base_url}{path}"
        request_id = uuid.uuid4().hex[:12]
        headers = {"X-Request-ID": request_id}

        for attempt in range(1 + self._max_retries):
            try:
                if method == "POST":
                    response = self._client.post(
                        url, json=payload, headers=headers, params=params
                    )
                else:
                    response = self._client.get(url, headers=headers, params=params)
            except httpx.TimeoutException as exc:
                logger.warning(
                    "%s timeout (attempt %d/%d)",
                    path,
                    attempt + 1,
                    1 + self._max_retries,
                )
                if attempt < self._max_retries:
                    self._backoff(attempt)
                    continue
                raise AtlaSentError(
                    f"Request to {path} timed out after "
                    f"{1 + self._max_retries} attempts",
                    code="timeout",
                    request_id=request_id,
                ) from exc
            except httpx.ConnectError as exc:
                logger.warning(
                    "%s connection failed (attempt %d/%d)",
                    self._base_url,
                    attempt + 1,
                    1 + self._max_retries,
                )
                if attempt < self._max_retries:
                    self._backoff(attempt)
                    continue
                raise AtlaSentError(
                    f"Failed to connect to AtlaSent API at "
                    f"{self._base_url} after {1 + self._max_retries} attempts",
                    code="network",
                    request_id=request_id,
                ) from exc
            except httpx.HTTPError as exc:
                raise AtlaSentError(
                    f"Request failed: {exc}",
                    code="network",
                    request_id=request_id,
                ) from exc

            if response.status_code == 429:
                retry_after = _parse_retry_after(response)
                raise RateLimitError(
                    retry_after=retry_after,
                    request_id=request_id,
                )
            if response.status_code == 401:
                raise AtlaSentError(
                    _server_message(response) or "Invalid API key",
                    status_code=401,
                    code="invalid_api_key",
                    request_id=request_id,
                )
            if response.status_code == 403:
                raise AtlaSentError(
                    _server_message(response)
                    or "Access forbidden — check your API key permissions",
                    status_code=403,
                    code="forbidden",
                    request_id=request_id,
                )
            if response.status_code >= 500:
                logger.warning(
                    "Server %d on %s (attempt %d/%d)",
                    response.status_code,
                    path,
                    attempt + 1,
                    1 + self._max_retries,
                )
                if attempt < self._max_retries:
                    self._backoff(attempt)
                    continue
                raise AtlaSentError(
                    f"API error {response.status_code}: {response.text[:500]}",
                    status_code=response.status_code,
                    code="server_error",
                    request_id=request_id,
                )
            if response.status_code >= 400:
                raise AtlaSentError(
                    f"API error {response.status_code}: {response.text[:500]}",
                    status_code=response.status_code,
                    code="bad_request",
                    request_id=request_id,
                )

            try:
                return (
                    response.json(),
                    _parse_rate_limit_headers(response),
                    request_id,
                )
            except ValueError as exc:
                raise AtlaSentError(
                    "Invalid JSON response from AtlaSent API",
                    code="bad_response",
                    request_id=request_id,
                ) from exc

        raise AtlaSentError(  # pragma: no cover
            f"Request to {path} failed after {1 + self._max_retries} attempts",
            code="network",
            request_id=request_id,
        )

    def _backoff(self, attempt: int) -> None:
        delay = min(_RETRY_MAX_DELAY, self._retry_backoff * (2**attempt))
        logger.debug("Retrying in %.1fs…", delay)
        time.sleep(delay)

    # ── HITL orchestration (path-routed /v1/hitl/*) ───────────────────────

    def create_hitl_escalation(
        self,
        request: HitlCreateRequest,
    ) -> HitlEscalationResult:
        body = request.model_dump(exclude_none=True)
        data, rate_limit, _ = self._post("/v1/hitl", body)
        return HitlEscalationResult(
            escalation=HitlEscalation.model_validate(data),
            rate_limit=rate_limit,
        )

    def list_hitl_escalations(
        self,
        *,
        status: HitlStatus | None = None,
        agent_id: str | None = None,
        assigned_to_user_id: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> ListHitlEscalationsResult:
        params: dict[str, str] = {}
        if status:
            params["status"] = status
        if agent_id:
            params["agent_id"] = agent_id
        if assigned_to_user_id:
            params["assigned_to_user_id"] = assigned_to_user_id
        if limit is not None:
            params["limit"] = str(limit)
        if cursor:
            params["cursor"] = cursor
        data, rate_limit, _ = self._get("/v1/hitl", params=params or None)
        return ListHitlEscalationsResult(**data, rate_limit=rate_limit)

    def get_hitl_escalation(self, escalation_id: str) -> HitlEscalationResult:
        if not escalation_id:
            raise AtlaSentError("escalation_id is required", code="bad_request")
        path = f"/v1/hitl/{quote(escalation_id, safe='')}"
        data, rate_limit, _ = self._get(path)
        return HitlEscalationResult(
            escalation=HitlEscalation.model_validate(data),
            rate_limit=rate_limit,
        )

    def list_hitl_approvals(self, escalation_id: str) -> HitlApprovalsResult:
        path = f"/v1/hitl/{quote(escalation_id, safe='')}/approvals"
        data, rate_limit, _ = self._get(path)
        return HitlApprovalsResult(**data, rate_limit=rate_limit)

    def get_hitl_chain(self, escalation_id: str) -> HitlChainResult:
        path = f"/v1/hitl/{quote(escalation_id, safe='')}/chain"
        data, rate_limit, _ = self._get(path)
        return HitlChainResult(**data, rate_limit=rate_limit)

    def approve_hitl_escalation(
        self,
        escalation_id: str,
        *,
        note: str | None = None,
    ) -> HitlEscalationResult:
        path = f"/v1/hitl/{quote(escalation_id, safe='')}/approve"
        body: dict[str, Any] = {}
        if note is not None:
            body["note"] = note
        data, rate_limit, _ = self._post(path, body)
        return HitlEscalationResult(
            escalation=HitlEscalation.model_validate(data),
            rate_limit=rate_limit,
        )

    def reject_hitl_escalation(
        self,
        escalation_id: str,
        *,
        note: str | None = None,
    ) -> HitlEscalationResult:
        path = f"/v1/hitl/{quote(escalation_id, safe='')}/reject"
        body: dict[str, Any] = {}
        if note is not None:
            body["note"] = note
        data, rate_limit, _ = self._post(path, body)
        return HitlEscalationResult(
            escalation=HitlEscalation.model_validate(data),
            rate_limit=rate_limit,
        )

    def escalate_hitl_escalation(
        self,
        escalation_id: str,
        *,
        to_role: str | None = None,
        to_user_id: str | None = None,
        reason: str | None = None,
    ) -> HitlEscalationResult:
        path = f"/v1/hitl/{quote(escalation_id, safe='')}/escalate"
        body: dict[str, Any] = {}
        if to_role is not None:
            body["to_role"] = to_role
        if to_user_id is not None:
            body["to_user_id"] = to_user_id
        if reason is not None:
            body["reason"] = reason
        data, rate_limit, _ = self._post(path, body)
        return HitlEscalationResult(
            escalation=HitlEscalation.model_validate(data),
            rate_limit=rate_limit,
        )

    def timeout_hitl_escalation(
        self,
        escalation_id: str,
    ) -> HitlEscalationResult:
        path = f"/v1/hitl/{quote(escalation_id, safe='')}/timeout"
        data, rate_limit, _ = self._post(path, {})
        return HitlEscalationResult(
            escalation=HitlEscalation.model_validate(data),
            rate_limit=rate_limit,
        )


def _server_message(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        return None
    if isinstance(body, dict):
        for key in ("error", "message", "reason"):
            value = body.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _parse_retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        pass
    try:
        parsed = parsedate_to_datetime(value)
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:  # pragma: no cover
        parsed = parsed.replace(tzinfo=timezone.utc)
    delta = (parsed - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, delta)


def _parse_rate_limit_headers(response: httpx.Response) -> RateLimitState | None:
    raw_limit = response.headers.get("x-ratelimit-limit")
    raw_remaining = response.headers.get("x-ratelimit-remaining")
    raw_reset = response.headers.get("x-ratelimit-reset")
    if raw_limit is None or raw_remaining is None or raw_reset is None:
        return None
    try:
        limit = int(raw_limit)
        remaining = int(raw_remaining)
    except (ValueError, TypeError):
        return None
    reset_at = _parse_reset_header(raw_reset)
    if reset_at is None:
        return None
    return RateLimitState(limit=limit, remaining=remaining, reset_at=reset_at)


def _parse_reset_header(raw: str) -> datetime | None:
    try:
        seconds = float(raw)
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    except (ValueError, TypeError):
        pass
    try:
        parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed
