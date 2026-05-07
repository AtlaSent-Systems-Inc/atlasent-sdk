"""Asynchronous AtlaSent API client (httpx.AsyncClient-based)."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
import warnings
from collections.abc import AsyncIterator
from urllib.parse import quote
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any

import httpx

from ._version import __version__
from .audit import AuditEventsResult, AuditExportResult
from .client import (
    _enforce_tls,
    _parse_rate_limit_headers,
    _redact_token,
    _validate_api_key,
)
from .exceptions import (
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    PermissionDeniedError,
    RateLimitError,
    _normalize_permit_outcome,
)
from .approval_artifact import ApprovalReference
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
    RevokePermitByIdResult,
    RevokePermitResult,
    StreamDecisionEvent,
    StreamProgressEvent,
    VerifyPermitByIdResult,
    VerifyRequest,
    VerifyResult,
)

if TYPE_CHECKING:
    from .cache import TTLCache

logger = logging.getLogger("atlasent")

DEFAULT_BASE_URL = "https://api.atlasent.io"
DEFAULT_TIMEOUT = 10
DEFAULT_MAX_RETRIES = 2
DEFAULT_RETRY_BACKOFF = 0.5


class AsyncAtlaSentClient:
    """Async client for the AtlaSent authorization API.

    Mirrors :class:`AtlaSentClient` but with ``async``/``await``.
    Uses ``httpx.AsyncClient`` under the hood.

    Args:
        api_key: Your AtlaSent API key (required).
        anon_key: An anonymous / public key for client-side contexts.
        base_url: Override the API base URL.
        timeout: HTTP request timeout in seconds.
        max_retries: Retries on transient errors (5xx, timeouts).
        retry_backoff: Base backoff in seconds (doubles each retry).

    Usage::

        async with AsyncAtlaSentClient(api_key="ask_live_...") as client:
            result = await client.gate("read_data", "agent-1")
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
        self._client = httpx.AsyncClient(
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "Authorization": f"Bearer {api_key}",
                "User-Agent": f"atlasent-python/{__version__}",
            },
            timeout=self._timeout,
        )

    # ── public API ────────────────────────────────────────────────

    async def evaluate(
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
        """Evaluate whether an action is authorized.

        Returns an :class:`EvaluateResult` on permit.
        Raises :class:`AtlaSentDenied` on deny (fail-closed).

        See :meth:`AtlaSentClient.evaluate` for full kwarg semantics.
        """
        ctx = context or {}
        if isinstance(approval, dict):
            approval = ApprovalReference.model_validate(approval)

        # Check cache
        if self._cache is not None:
            from .cache import TTLCache

            cache_key = TTLCache.make_key(action_type, actor_id, ctx)
            cached = self._cache.get(cache_key)
            if cached is not None:
                logger.debug("evaluate cache hit for %s (async)", cache_key)
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
        logger.debug("evaluate action=%r actor=%r (async)", action_type, actor_id)
        data, rate_limit, request_id = await self._post(
            "/v1-evaluate", req.model_dump(by_alias=True, exclude_none=True)
        )

        # Tolerate both canonical {decision, permit_token} and legacy
        # {permitted, decision_id}.
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

        # Store in cache
        if self._cache is not None:
            self._cache.put(cache_key, result)

        return result

    async def evaluate_preflight(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> EvaluatePreflightResult:
        """Pre-flight evaluation that always returns the constraint trace.

        Async mirror of :meth:`AtlaSentClient.evaluate_preflight`. Wraps
        ``POST /v1-evaluate?include=constraint_trace`` so a workflow's
        submission step can surface trivial defects (missing fields,
        wrong roles) BEFORE pushing the request to an approval queue.

        Returns an :class:`EvaluatePreflightResult` carrying the
        regular :class:`EvaluateResult` plus the
        :class:`ConstraintTrace`. Does NOT raise on a non-allow
        decision: the caller branches on
        ``result.evaluation.decision`` and renders failing stages from
        ``result.constraint_trace``.

        On older atlasent-api deployments that omit the trace,
        ``constraint_trace`` is ``None`` rather than raising —
        forward-compatible degradation.

        Performance: one extra round-trip on submission, latency
        comparable to :meth:`evaluate` with a fuller response body.
        Prefer :meth:`evaluate` if the caller does not need the trace.
        """
        ctx = context or {}
        req = EvaluateRequest(
            action_type=action_type,
            actor_id=actor_id,
            context=ctx,
        )
        logger.debug(
            "evaluate_preflight action=%r actor=%r (async)", action_type, actor_id
        )
        data, rate_limit, request_id = await self._post(
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

    async def verify(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context: dict[str, Any] | None = None,
        *,
        require_approval: bool | None = None,
    ) -> VerifyResult:
        """Verify a previously issued permit token.

        .. deprecated::
           Use :meth:`verify_permit_by_id` — the canonical REST surface
           returns the unified verification envelope plus the full
           PermitRecord. Will be removed in ``atlasent`` v3.

        See :meth:`AtlaSentClient.verify` for full kwarg semantics.
        """
        warnings.warn(
            "AsyncAtlaSentClient.verify() is deprecated. Use "
            "verify_permit_by_id() for the canonical REST surface; it "
            "returns the unified verification envelope (valid / "
            "verification_type / reason / verified_at / evidence) plus "
            "the full PermitRecord. Will be removed in v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        # `context` arg preserved on the public method signature for
        # backward-compat but no longer sent on the wire — handler.ts
        # cross-checks via action_type / actor_id only.
        del context
        req = VerifyRequest(
            permit_token=permit_token,
            action_type=action_type,
            actor_id=actor_id,
            require_approval=require_approval,
        )
        logger.debug("verify token=%s (async)", _redact_token(permit_token))
        data, rate_limit, request_id = await self._post(
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

    async def protect(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
    ) -> Permit:
        """Authorize an action end-to-end (async). The category primitive.

        Async mirror of :meth:`AtlaSentClient.protect`. On allow,
        returns a verified :class:`Permit`; on deny or verification
        failure raises :class:`AtlaSentDeniedError`; on transport /
        auth / rate-limit / server error raises :class:`AtlaSentError`.

        Example::

            from atlasent import AsyncAtlaSentClient

            async with AsyncAtlaSentClient(api_key="ask_live_...") as client:
                permit = await client.protect(
                    agent="deploy-bot",
                    action="deploy_to_production",
                    context={"commit": commit},
                )
        """
        ctx = context or {}
        try:
            eval_result = await self.evaluate(action, agent, ctx)
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

        verify_result = await self.verify(eval_result.permit_token, action, agent, ctx)

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
        )

    async def protect_stream(
        self,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
    ) -> AsyncIterator[StreamDecisionEvent | StreamProgressEvent]:
        """Open a streaming evaluation session against ``POST /v1-evaluate-stream``.

        Yields :class:`StreamDecisionEvent` and :class:`StreamProgressEvent`
        objects as the server emits them. The iterator ends cleanly when the
        server sends ``event: done``; it raises :class:`AtlaSentError` on
        transport errors or when the server sends ``event: error``.

        Usage::

            async for event in client.protect_stream("my-agent", "my-action"):
                if event.type == "decision" and event.is_final:
                    break
        """
        url = f"{self._base_url}/v1-evaluate-stream"
        payload = {
            "action": action,
            "agent": agent,
            "context": context or {},
            "api_key": self._api_key,
        }
        request_id = uuid.uuid4().hex[:12]
        headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self._api_key}",
            "User-Agent": f"atlasent-python/{__version__}",
            "X-Request-ID": request_id,
        }

        async with self._client.stream(
            "POST",
            url,
            content=json.dumps(payload).encode(),
            headers=headers,
        ) as response:
            if response.status_code != 200:
                # Drain the body so the connection can be reused; we don't
                # surface the body in the error because it's an SSE stream
                # and the head bytes are unlikely to be a useful message.
                await response.aread()
                raise AtlaSentError(
                    "AtlaSent stream request failed with status "
                    f"{response.status_code}",
                    code="server_error",
                    status_code=response.status_code,
                    request_id=request_id,
                )

            async for event in _parse_sse(response.aiter_lines(), request_id):
                yield event

    async def gate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> GateResult:
        """Evaluate then verify in one call — the happy-path shortcut.

        .. deprecated::
           Use :meth:`protect` for fail-closed execution, or
           :meth:`evaluate` + :meth:`verify` to inspect the decision
           and verify separately. Will be removed in ``atlasent`` v3.
        """
        warnings.warn(
            "AsyncAtlaSentClient.gate() is deprecated. Use protect() for "
            "fail-closed execution or evaluate() + verify() to inspect "
            "the decision and verify separately. Will be removed in v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        ctx = context or {}
        eval_result = await self.evaluate(action_type, actor_id, ctx)
        verify_result = await self.verify(
            eval_result.permit_token, action_type, actor_id, ctx
        )
        return GateResult(evaluation=eval_result, verification=verify_result)

    async def authorize(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
        verify: bool = True,
        raise_on_deny: bool = False,
    ) -> AuthorizationResult:
        """Authorize an agent action — async version of
        :meth:`AtlaSentClient.authorize`.

        .. deprecated::
           Use :meth:`protect` for fail-closed execution
           (recommended — no ``permitted=False`` return path to forget),
           or :meth:`evaluate` to inspect the four-value decision.
           Will be removed in ``atlasent`` v3.
        """
        warnings.warn(
            "AsyncAtlaSentClient.authorize() is deprecated. Use protect() for "
            "fail-closed execution (recommended) or evaluate() to inspect "
            "the four-value decision. Will be removed in v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        ctx = context or {}
        try:
            eval_result = await self.evaluate(action, agent, ctx)
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
            verify_result = await self.verify(
                eval_result.permit_token, action, agent, ctx
            )
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

    # ── lifecycle ─────────────────────────────────────────────────

    async def close(self) -> None:
        """Close the underlying HTTP client and release resources."""
        await self._client.aclose()
        logger.debug("AsyncAtlaSentClient closed")

    async def __aenter__(self) -> AsyncAtlaSentClient:
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:  # noqa: ANN001
        await self.close()

    async def key_self(self) -> ApiKeySelfResult:
        """Self-introspection of the API key this client was constructed with.

        Calls ``GET /v1-api-key-self``. Never returns the raw key or its
        hash — safe to surface in operator dashboards. Useful for
        ``IP_NOT_ALLOWED`` debugging (the server tells you exactly which
        client IP it saw), proactive expiry warnings, and scope
        introspection before attempting a scope-gated action.

        Response also includes ``rate_limit`` so key-introspection
        doubles as a cheap rate-limit probe without consuming a permit.

        Raises:
            AtlaSentError: Network error, timeout, unexpected response,
                or malformed payload.
            RateLimitError: HTTP 429.
        """
        logger.debug("key_self")
        data, rate_limit, request_id = await self._get("/v1-api-key-self")

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

    async def revoke_permit(
        self,
        permit_id: str,
        *,
        reason: str | None = None,
    ) -> RevokePermitResult:
        """Revoke a previously-issued permit (``POST /v1-revoke-permit``).

        .. deprecated::
           Use :meth:`revoke_permit_by_id` — the canonical REST surface
           returns the full updated PermitRecord with revoked_at /
           revoked_by / revoke_reason populated. Will be removed in
           ``atlasent`` v3.

        Once revoked the permit will no longer pass :meth:`verify`.
        The revocation is recorded in the audit log with the optional *reason*.
        """
        warnings.warn(
            "AsyncAtlaSentClient.revoke_permit() is deprecated. Use "
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
        logger.debug("revoke_permit permit_id=%s (async)", _redact_token(permit_id))
        data, rate_limit, request_id = await self._post("/v1-revoke-permit", payload)

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

    # ── Canonical REST surface (parity with sync client) ──────────

    async def get_permit(self, permit_id: str) -> GetPermitResult:
        """Get a single permit's full lifecycle state
        (``GET /v1/permits/{permit_id}``).

        Async parity for :meth:`AtlaSentClient.get_permit`. See the
        sync version for full semantics.
        """
        if not permit_id:
            raise AtlaSentError("permit_id is required", code="bad_request")
        path = f"/v1/permits/{quote(permit_id, safe='')}"
        data, rate_limit, _ = await self._get(path)
        return GetPermitResult(
            permit=PermitRecord.model_validate(data),
            rate_limit=rate_limit,
        )

    async def list_permits(
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
        """List permits issued to the calling org
        (``GET /v1/permits``).

        Async parity for :meth:`AtlaSentClient.list_permits`. See the
        sync version for full kwarg semantics.
        """
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

        data, rate_limit, request_id = await self._get(
            "/v1/permits", params=params or None
        )
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

    async def revoke_permit_by_id(
        self,
        permit_id: str,
        *,
        reason: str | None = None,
    ) -> RevokePermitByIdResult:
        """Revoke a permit through the canonical REST surface
        (``POST /v1/permits/{permit_id}/revoke``).

        Async parity for :meth:`AtlaSentClient.revoke_permit_by_id`.
        """
        if not permit_id:
            raise AtlaSentError("permit_id is required", code="bad_request")
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        path = f"/v1/permits/{quote(permit_id, safe='')}/revoke"
        data, rate_limit, _ = await self._post(path, body)
        return RevokePermitByIdResult(
            permit=PermitRecord.model_validate(data),
            rate_limit=rate_limit,
        )

    async def verify_permit_by_id(self, permit_id: str) -> VerifyPermitByIdResult:
        """Verify a permit through the canonical REST surface
        (``POST /v1/permits/{permit_id}/verify``).

        Async parity for :meth:`AtlaSentClient.verify_permit_by_id`.
        """
        if not permit_id:
            raise AtlaSentError("permit_id is required", code="bad_request")
        path = f"/v1/permits/{quote(permit_id, safe='')}/verify"
        data, rate_limit, request_id = await self._post(path, {})
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
                "Malformed /v1/permits/{id}/verify response: missing canonical envelope fields",
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

    async def list_audit_events(
        self,
        *,
        types: str | None = None,
        actor_id: str | None = None,
        from_: str | None = None,
        to: str | None = None,
        limit: int | None = None,
        cursor: str | None = None,
    ) -> AuditEventsResult:
        """List persisted audit events (``GET /v1-audit/events``).

        Async mirror of :meth:`AtlaSentClient.list_audit_events`. See
        that method for argument semantics.
        """
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

        logger.debug("list_audit_events params=%r (async)", params)
        data, rate_limit, request_id = await self._request(
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

    async def create_audit_export(
        self,
        *,
        types: str | None = None,
        actor_id: str | None = None,
        from_: str | None = None,
        to: str | None = None,
    ) -> AuditExportResult:
        """Request a signed audit-export bundle
        (``POST /v1-audit/exports``).

        Async mirror of :meth:`AtlaSentClient.create_audit_export`.
        See that method for verification-workflow notes.
        """
        payload: dict[str, Any] = {}
        if types:
            payload["types"] = types
        if actor_id:
            payload["actor_id"] = actor_id
        if from_:
            payload["from"] = from_
        if to:
            payload["to"] = to

        logger.debug("create_audit_export filter=%r (async)", payload)
        data, rate_limit, request_id = await self._post("/v1-audit/exports", payload)

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

    # ── internals ─────────────────────────────────────────────────

    async def _post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        """POST with retry on transient failures.

        Returns ``(body, rate_limit, request_id)``. ``rate_limit`` is
        parsed from ``X-RateLimit-*`` headers on the response or
        ``None`` when the server doesn't emit them. Callers use
        ``request_id`` to attach the ``X-Request-ID`` we sent to any
        exception they raise while interpreting the body, so call
        sites see the same correlation id whether the request failed
        at transport / HTTP status time (raised inside ``_post``) or
        at body-shape time (raised by the caller after ``_post``
        returns).

        ``params`` is appended as a URL query string (e.g.
        ``?include=constraint_trace`` for the preflight helper). The
        request body is unchanged.
        """
        return await self._request("POST", path, payload, params=params)

    async def _get(
        self,
        path: str,
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        """GET with retry on transient failures.

        Same ``(body, rate_limit, request_id)`` shape as :meth:`_post`
        so response-parsing code is shared.

        ``params`` is appended as a URL query string when present.
        """
        return await self._request("GET", path, None, params=params)

    async def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        """Shared retry + error-mapping core for POST / GET.

        ``params`` is only honored for GET and is serialized as URL
        query parameters.
        """
        url = f"{self._base_url}{path}"
        request_id = uuid.uuid4().hex[:12]
        headers = {"X-Request-ID": request_id}

        for attempt in range(1 + self._max_retries):
            try:
                if method == "POST":
                    response = await self._client.post(
                        url, json=payload, headers=headers, params=params
                    )
                else:
                    response = await self._client.get(
                        url, headers=headers, params=params
                    )
            except httpx.TimeoutException as exc:
                logger.warning(
                    "%s timeout (attempt %d/%d)",
                    path,
                    attempt + 1,
                    1 + self._max_retries,
                )
                if attempt < self._max_retries:
                    await self._backoff(attempt)
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
                    await self._backoff(attempt)
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
                    await self._backoff(attempt)
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

    async def _backoff(self, attempt: int) -> None:
        delay = self._retry_backoff * (2**attempt)
        logger.debug("Retrying in %.1fs… (async)", delay)
        await asyncio.sleep(delay)


def _server_message(response: httpx.Response) -> str | None:
    """Return `message` / `reason` from a JSON error body, if present."""
    try:
        body = response.json()
    except ValueError:
        return None
    if isinstance(body, dict):
        for key in ("message", "reason"):
            value = body.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def _parse_retry_after(response: httpx.Response) -> float | None:
    """Parse a ``Retry-After`` header per RFC 9110 §10.2.3.

    Accepts both forms:
    - ``delta-seconds`` — ``"30"`` → ``30.0``
    - ``HTTP-date``      — ``"Wed, 21 Oct 2026 07:28:00 GMT"`` →
      non-negative seconds remaining until that instant.

    Returns ``None`` if the header is absent or unparseable. An
    HTTP-date in the past is clamped to ``0.0`` so retry-pacing code
    still backs off consistently rather than silently skipping the
    header.
    """
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


# ── SSE parser ────────────────────────────────────────────────────────────────


async def _parse_sse(
    lines: AsyncIterator[str],
    request_id: str,
) -> AsyncIterator[StreamDecisionEvent | StreamProgressEvent]:
    """Parse server-sent events from an async line iterator.

    Yields :class:`StreamDecisionEvent` and :class:`StreamProgressEvent`.
    Raises :class:`AtlaSentError` on ``event: error``.
    Returns (stops iterating) on ``event: done``.
    Unknown event types are silently skipped for forward compatibility.
    """
    event_type = "message"
    data_lines: list[str] = []

    async for line in lines:
        if line == "":
            # Blank line: dispatch accumulated event
            if data_lines:
                data = "\n".join(data_lines)
                data_lines = []

                if event_type == "done":
                    return

                try:
                    parsed: dict[str, Any] = json.loads(data)
                except (ValueError, TypeError) as exc:
                    raise AtlaSentError(
                        "Malformed SSE data from AtlaSent API",
                        code="bad_response",
                        request_id=request_id,
                    ) from exc

                if event_type == "error":
                    raise AtlaSentError(
                        parsed.get("message", "Stream error from AtlaSent API"),
                        code=parsed.get("code", "server_error"),
                        request_id=parsed.get("request_id", request_id),
                    )

                if event_type == "decision":
                    yield StreamDecisionEvent.from_wire(parsed)
                elif event_type == "progress":
                    extra = {
                        k: v for k, v in parsed.items() if k not in ("type", "stage")
                    }
                    yield StreamProgressEvent(
                        stage=str(parsed.get("stage", "")),
                        **extra,
                    )
                # unknown event types skipped

            event_type = "message"
        elif line.startswith("event: "):
            event_type = line[7:].strip()
        elif line.startswith("data: "):
            data_lines.append(line[6:])
