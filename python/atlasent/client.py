"""Synchronous AtlaSent API client (httpx-based)."""

from __future__ import annotations

import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlparse

import httpx

from ._version import __version__
from .audit import AuditEventsResult, AuditExportResult
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
    RateLimitState,
    RevokePermitResult,
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

# API-key prefix contract per atlasent-api/supabase/functions/_shared/auth.ts:
#   "ask_live_<entropy>" — production keys
#   "ask_test_<entropy>" — non-production keys
# Validated client-side so a mis-pasted key (with whitespace, quotes,
# or a leftover wrapping char) trips loudly at construction rather
# than yielding a 401 mid-conversation. The character class matches
# what atlasent-api accepts; widen here only if the server widens
# first.
_API_KEY_PATTERN = re.compile(r"^ask_(?:live|test)_[A-Za-z0-9_-]+$")


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
            },
            timeout=self._timeout,
        )

    # ── public API ────────────────────────────────────────────────

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
        """Evaluate whether an action is authorized.

        Returns an :class:`EvaluateResult` on permit.
        Raises :class:`AtlaSentDenied` on deny (fail-closed).

        Args:
            action_type: The action to authorize (e.g. ``"modify_patient_record"``).
            actor_id: Identifier of the actor (agent or user).
            context: Arbitrary context dict for policy evaluation.
            resource_id: Resource the action targets. Bound into the
                canonical action hash that approval artifacts cover.
            amount: Optional monetary / quantity bound. Bound into the
                canonical action hash.
            approval: Optional signed approval — either an
                :class:`~atlasent.ApprovalReference` (with ``approval_id``
                and/or ``artifact``) or a plain dict matching that
                shape. The server verifies it before issuing a permit
                when the action requires human approval.
            require_approval: When ``True``, asserts that this action
                requires verified human approval even if the
                action_type heuristic doesn't match. Carried server-
                side; consumers can re-assert on
                :meth:`AtlaSentClient.verify` to enforce the linkage
                on consume.

        Raises:
            AtlaSentDenied: The action was explicitly denied.
            AtlaSentError: Network error, timeout, or unexpected response.
            RateLimitError: HTTP 429.
        """
        ctx = context or {}
        # Accept dicts for ergonomics; the model normalizes shape.
        if isinstance(approval, dict):
            approval = ApprovalReference.model_validate(approval)

        # Check cache
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

        # Tolerate both canonical {decision, permit_token} and legacy
        # {permitted, decision_id}. The model_validator on EvaluateResult
        # also normalizes — this guard is just to fail-fast with a useful
        # error if neither shape is present.
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

        # Fail-closed: server allowed but didn't issue a permit identifier
        # we can verify later. Treat the whole response as malformed.
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

    def evaluate_preflight(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> EvaluatePreflightResult:
        """Pre-flight evaluation that always returns the constraint trace.

        Wraps ``POST /v1-evaluate?include=constraint_trace``. Use this
        from a workflow's submission step to surface trivial defects
        (missing fields, wrong roles, mis-set context) BEFORE pushing
        the request onto an approval queue — only requests that would
        actually pass make it through to a human reviewer.

        Returns an :class:`EvaluatePreflightResult` carrying the
        regular :class:`EvaluateResult` plus the
        :class:`ConstraintTrace`. Unlike :meth:`evaluate`, this method
        does NOT raise on a non-allow decision: the whole point is to
        inspect both the outcome AND the per-policy trace, so the
        caller branches on ``result.evaluation.decision`` and reads
        ``result.constraint_trace`` to render the failing stages.

        The constraint-trace shape mirrors
        ``ConstraintTraceResponse`` in atlasent-api
        (``packages/types/src/index.ts``). On older atlasent-api
        deployments that omit the trace, ``constraint_trace`` is
        ``None`` rather than raising — forward-compatible degradation.

        Performance: one extra round-trip on submission. Latency is
        comparable to :meth:`evaluate`; the response body is fuller
        (includes the per-stage trace) so the wire payload is larger.
        If the caller does not need the trace, prefer :meth:`evaluate`.

        Args:
            action_type: The action being authorized.
            actor_id: Identifier of the actor.
            context: Arbitrary policy context.

        Raises:
            AtlaSentError: Network / server / malformed-response errors.
            RateLimitError: HTTP 429.
        """
        ctx = context or {}
        req = EvaluateRequest(
            action_type=action_type,
            actor_id=actor_id,
            context=ctx,
        )
        logger.debug(
            "evaluate_preflight action=%r actor=%r", action_type, actor_id
        )
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
    ) -> VerifyResult:
        """Verify a previously issued permit token.

        Args:
            permit_token: The token from :meth:`evaluate`.
            action_type: Optionally re-state the action for cross-check.
            actor_id: Optionally re-state the actor for cross-check.
            context: Optionally re-state context for cross-check.
            require_approval: When ``True``, asserts the consume must
                produce a permit row with a populated approval
                binding. If the row carries no binding, the server
                returns ``APPROVAL_LINKAGE_MISSING`` (``valid=False``,
                ``consumed=True``). Use this when the server-side
                heuristic doesn't match this action.

        Returns:
            A :class:`VerifyResult`. On success ``valid=True`` and
            ``approval`` carries the persisted binding (if any).
            ``consumed`` is ``True`` even on
            ``APPROVAL_LINKAGE_MISSING`` — the permit is burned, do
            not retry.

        Raises:
            AtlaSentError: Network error, timeout, or unexpected response.
            RateLimitError: HTTP 429.
        """
        # `context` arg is preserved on the public method signature for
        # backward-compat but no longer sent on the wire — handler.ts
        # cross-checks via action_type / actor_id only.
        del context  # explicitly mark unused
        req = VerifyRequest(
            permit_token=permit_token,
            action_type=action_type,
            actor_id=actor_id,
            require_approval=require_approval,
        )
        logger.debug("verify token=%s", _redact_token(permit_token))
        data, rate_limit, request_id = self._post(
            "/v1-verify-permit", req.model_dump(by_alias=True, exclude_none=True)
        )
        # Tolerate both canonical {valid, outcome} and legacy {verified, outcome}.
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
        """Authorize an action end-to-end. The category primitive.

        On allow, returns a verified :class:`Permit` (both
        ``/v1-evaluate`` and ``/v1-verify-permit`` have cleared). On
        anything else, raises — never returns a "denied" value:

        - :class:`AtlaSentDeniedError` — policy denied the action, or
          the resulting permit failed verification. Fail-closed:
          if this raises, the action MUST NOT proceed.
        - :class:`AtlaSentError` — transport, timeout, auth, rate
          limit, or server error. Same fail-closed contract.

        Matches the TypeScript SDK's ``atlasent.protect()`` for
        cross-language parity.

        Example::

            from atlasent import AtlaSentClient

            client = AtlaSentClient(api_key="ask_live_...")

            permit = client.protect(
                agent="deploy-bot",
                action="deploy_to_production",
                context={"commit": commit, "approver": approver},
            )
            # If we got here, AtlaSent authorized it end-to-end.
            # Log permit.permit_id + permit.audit_hash for audit.
        """
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

        verify_result = self.verify(eval_result.permit_token, action, agent, ctx)

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

    def gate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> GateResult:
        """Evaluate then verify in one call — the happy-path shortcut.

        Calls :meth:`evaluate`; if permitted, immediately calls
        :meth:`verify` with the resulting permit token.  Returns a
        :class:`GateResult` containing both results.

        Raises:
            AtlaSentDenied: The action was denied at evaluation.
            AtlaSentError: Any failure at either step.
        """
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
        """Authorize an agent action — the one-call public API.

        Calls ``POST /v1-evaluate`` and (unless ``verify=False``)
        ``POST /v1-verify-permit`` and returns an
        :class:`AuthorizationResult` whose :attr:`permitted` field
        tells you whether to proceed.

        Unlike :meth:`evaluate`, this method does **not** raise on
        denial by default — the caller inspects ``result.permitted``.
        Network, configuration, rate-limit, and server errors still
        raise, keeping the SDK fail-closed.

        Args:
            agent: Identifier of the calling agent (e.g. ``"clinical-data-agent"``).
            action: The action being authorized (e.g. ``"modify_patient_record"``).
            context: Arbitrary policy context (user, env, resource IDs).
            verify: If ``True`` (default), immediately verify the permit
                and populate ``permit_hash`` / ``verified`` on the result.
            raise_on_deny: If ``True``, raise :class:`PermissionDeniedError`
                instead of returning a non-permitted result.

        Returns:
            :class:`AuthorizationResult` with ``.permitted``,
            ``.permit_token``, ``.audit_hash``, ``.permit_hash``, etc.

        Raises:
            PermissionDeniedError: When denied and ``raise_on_deny=True``.
            AtlaSentError: Network / server / configuration errors.
            RateLimitError: HTTP 429.
        """
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

    # ── lifecycle ─────────────────────────────────────────────────

    def close(self) -> None:
        """Close the underlying HTTP client and release resources."""
        self._client.close()
        logger.debug("AtlaSentClient closed")

    def __enter__(self) -> AtlaSentClient:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:  # noqa: ANN001
        self.close()

    def key_self(self) -> ApiKeySelfResult:
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
        """Revoke a previously-issued permit (``POST /v1-revoke-permit``).

        Once revoked, the permit will no longer pass :meth:`verify`.
        The revocation is recorded in the audit log with the optional *reason*.

        Args:
            permit_id: The ``decision_id`` / ``permit_token`` to revoke.
            reason: Human-readable reason stored in the audit log.

        Returns:
            :class:`RevokePermitResult` with ``revoked=True`` on success.

        Raises:
            :class:`AtlaSentError` on transport or server errors.
        """
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

    def get_permit(self, permit_id: str) -> GetPermitResult:
        """Get a single permit's full lifecycle state
        (``GET /v1/permits/{permit_id}``).

        Returns the canonical :class:`PermitRecord` — including
        ``status``, all timestamps, ``revoked_at`` / ``revoked_by`` /
        ``revoke_reason`` (when ``status == 'revoked'``), and the bound
        ``payload_hash`` / ``decision_id``.

        Operator-facing introspection — answers "what state is this
        permit in, and why?" without reading audit logs.

        Args:
            permit_id: The permit's ``pt_…`` ID.

        Raises:
            :class:`AtlaSentError` on transport / auth failures, ``404``
            (permit not in calling org), or ``410`` (expired before
            retrieval).
        """
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
        """List permits issued to the calling org, most-recently-issued
        first (``GET /v1/permits``).

        Operator observability surface. Cursor-paged. Filters narrow on
        the server side.

        Args:
            status: Filter by lifecycle status (``issued`` / ``verified``
                / ``consumed`` / ``expired`` / ``revoked``).
            actor_id: Filter by actor.
            action_type: Filter by action class.
            from_: ISO-8601 lower bound on ``created_at``. Trailing
                underscore avoids the Python keyword.
            to: ISO-8601 upper bound on ``created_at``.
            limit: Page size. Server max is 500; default 50.
            cursor: Pass ``next_cursor`` from a prior response to page
                forward.

        Returns:
            :class:`ListPermitsResult` with ``permits``, ``total``, and
            an optional ``next_cursor``.
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

        data, rate_limit, request_id = self._get(
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
        """List persisted audit events (``GET /v1-audit/events``).

        Returned rows are wire-identical with the server — snake_case
        field names, including ``previous_hash`` and the ``hash`` chain
        — so the response can be fed to
        :func:`atlasent.verify_audit_bundle` when paired with a signed
        export.

        Args:
            types: Comma-joined list of event types (e.g.
                ``"evaluate.allow,policy.updated"``).
            actor_id: Filter to a single actor.
            from_: Inclusive lower bound on ``occurred_at`` (ISO 8601).
                Trailing underscore avoids the Python keyword.
            to: Inclusive upper bound on ``occurred_at``.
            limit: Page size. Server default 50, max 500.
            cursor: Opaque cursor returned as ``next_cursor`` by the
                prior page.

        Raises:
            AtlaSentError: Network error, timeout, unexpected response,
                or malformed payload.
            RateLimitError: HTTP 429.
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
        """Request a signed audit-export bundle
        (``POST /v1-audit/exports``).

        The returned :class:`AuditExportResult` wraps the raw server
        JSON in :attr:`AuditExportResult.bundle`. Pass that dict to
        :func:`atlasent.verify_audit_bundle` to run the offline
        integrity + signature check::

            result = client.create_audit_export()
            outcome = atlasent.verify_audit_bundle(
                result.bundle, keys=[...]
            )

        All filter args are optional; omit for a full-org bundle.

        Args:
            types: Comma-joined list of event types.
            actor_id: Filter to a single actor.
            from_: Inclusive lower bound on ``occurred_at``.
            to: Inclusive upper bound on ``occurred_at``.

        Raises:
            AtlaSentError: Network error, timeout, unexpected response,
                or malformed payload.
            RateLimitError: HTTP 429.
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

    # ── internals ─────────────────────────────────────────────────

    def _post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        """POST with retry on transient failures (5xx, timeouts).

        Returns ``(body, rate_limit, request_id)`` — rate_limit is parsed
        from ``X-RateLimit-*`` headers on the response, or ``None`` when
        the server doesn't emit them.

        ``params`` is appended as a URL query string (e.g.
        ``?include=constraint_trace`` for the preflight helper). The
        request body is unchanged.
        """
        return self._request("POST", path, payload, params=params)

    def _get(
        self,
        path: str,
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        """GET with retry on transient failures (5xx, timeouts).

        Returns ``(body, rate_limit, request_id)`` — same shape as
        :meth:`_post` so response-parsing code is shared.

        ``params`` is appended as a URL query string when present.
        """
        return self._request("GET", path, None, params=params)

    def _request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None,
        *,
        params: dict[str, str] | None = None,
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        """Shared retry + error-mapping core for POST / GET.

        ``payload`` is serialized as JSON for POST; GET sends no body.
        ``params`` is only honored for GET and is serialized as URL
        query parameters.
        """
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
        delay = self._retry_backoff * (2**attempt)
        logger.debug("Retrying in %.1fs…", delay)
        time.sleep(delay)


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

    See :func:`atlasent.async_client._parse_retry_after`.
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


def _parse_rate_limit_headers(response: httpx.Response) -> RateLimitState | None:
    """Parse the server's ``X-RateLimit-*`` header triple into a typed
    :class:`RateLimitState`.

    Returns ``None`` when any of the three headers is missing or
    unparseable — callers treat that as "the server didn't emit
    rate-limit state" rather than "the window is empty".

    ``X-RateLimit-Reset`` is accepted as either unix-seconds (what the
    AtlaSent edge functions emit today) or an ISO 8601 timestamp.
    """
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
    """Accept either unix-seconds (the server's current convention) or
    an ISO 8601 timestamp; return a timezone-aware UTC datetime."""
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
