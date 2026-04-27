"""Asynchronous AtlaSent API client (httpx.AsyncClient-based)."""

from __future__ import annotations

import asyncio
import logging
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any

import httpx

from ._version import __version__
from .audit import AuditEventsResult, AuditExportResult
from .client import _parse_rate_limit_headers
from .exceptions import (
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    PermissionDeniedError,
    RateLimitError,
)
from .models import (
    ApiKeySelfResult,
    AuthorizationResult,
    EvaluateRequest,
    EvaluateResult,
    GateResult,
    Permit,
    RateLimitState,
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
        self._api_key = api_key
        self._anon_key = anon_key
        self._base_url = base_url.rstrip("/")
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
    ) -> EvaluateResult:
        """Evaluate whether an action is authorized.

        Returns an :class:`EvaluateResult` on permit.
        Raises :class:`AtlaSentDenied` on deny (fail-closed).
        """
        ctx = context or {}

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
            api_key=self._api_key,
        )
        logger.debug("evaluate action=%r actor=%r (async)", action_type, actor_id)
        data, rate_limit, request_id = await self._post(
            "/v1-evaluate", req.model_dump(by_alias=True)
        )

        if not isinstance(data.get("permitted"), bool) or not isinstance(
            data.get("decision_id"), str
        ):
            raise AtlaSentError(
                "Malformed /v1-evaluate response: missing or non-scalar "
                "`permitted` or `decision_id`",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )

        permitted = data["permitted"]
        if not permitted:
            raise AtlaSentDenied(
                decision=str(permitted),
                permit_token=data.get("decision_id", ""),
                reason=data.get("reason", ""),
                request_id=request_id,
                response_body=data,
            )

        result = EvaluateResult.model_validate(data)
        result.rate_limit = rate_limit
        logger.info(
            "evaluate permitted action=%r actor=%r token=%s",
            action_type,
            actor_id,
            result.permit_token,
        )

        # Store in cache
        if self._cache is not None:
            self._cache.put(cache_key, result)

        return result

    async def verify(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context: dict[str, Any] | None = None,
    ) -> VerifyResult:
        """Verify a previously issued permit token."""
        req = VerifyRequest(
            permit_token=permit_token,
            action_type=action_type,
            actor_id=actor_id,
            context=context or {},
            api_key=self._api_key,
        )
        logger.debug("verify token=%s (async)", permit_token)
        data, rate_limit, request_id = await self._post(
            "/v1-verify-permit", req.model_dump(by_alias=True)
        )
        if not isinstance(data.get("verified"), bool):
            raise AtlaSentError(
                "Malformed /v1-verify-permit response: missing `verified`",
                code="bad_response",
                request_id=request_id,
                response_body=data,
            )
        result = VerifyResult.model_validate(data)
        result.rate_limit = rate_limit
        logger.info("verify token=%s valid=%s", permit_token, result.valid)
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
            )

        return Permit(
            permit_id=eval_result.permit_token,
            permit_hash=verify_result.permit_hash,
            audit_hash=eval_result.audit_hash,
            reason=eval_result.reason,
            timestamp=verify_result.timestamp,
        )

    async def gate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> GateResult:
        """Evaluate then verify in one call — the happy-path shortcut."""
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
        """
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
        self, path: str, payload: dict[str, Any]
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
        """
        return await self._request("POST", path, payload)

    async def _get(
        self, path: str
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        """GET with retry on transient failures.

        Same ``(body, rate_limit, request_id)`` shape as :meth:`_post`
        so response-parsing code is shared.
        """
        return await self._request("GET", path, None)

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
                        url, json=payload, headers=headers
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

        raise AtlaSentError(
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
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    delta = (parsed - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, delta)
