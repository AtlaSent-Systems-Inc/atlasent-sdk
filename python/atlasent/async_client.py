"""Asynchronous AtlaSent API client (httpx.AsyncClient-based)."""

from __future__ import annotations

import asyncio
import logging
import uuid
from typing import TYPE_CHECKING, Any

import httpx

from ._version import __version__
from .exceptions import (
    AtlaSentDenied,
    AtlaSentError,
    PermissionDeniedError,
    RateLimitError,
)
from .models import (
    AuthorizationResult,
    EvaluateRequest,
    EvaluateResult,
    GateResult,
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
        data = await self._post("/v1-evaluate", req.model_dump(by_alias=True))

        if not isinstance(data.get("permitted"), bool) or not isinstance(
            data.get("decision_id"), str
        ):
            raise AtlaSentError(
                "Malformed /v1-evaluate response: missing or non-scalar "
                "`permitted` or `decision_id`",
                code="bad_response",
                response_body=data,
            )

        permitted = data["permitted"]
        if not permitted:
            raise AtlaSentDenied(
                decision=str(permitted),
                permit_token=data.get("decision_id", ""),
                reason=data.get("reason", ""),
                response_body=data,
            )

        result = EvaluateResult.model_validate(data)
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
        data = await self._post("/v1-verify-permit", req.model_dump(by_alias=True))
        if not isinstance(data.get("verified"), bool):
            raise AtlaSentError(
                "Malformed /v1-verify-permit response: missing `verified`",
                code="bad_response",
                response_body=data,
            )
        result = VerifyResult.model_validate(data)
        logger.info("verify token=%s valid=%s", permit_token, result.valid)
        return result

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

    # ── internals ─────────────────────────────────────────────────

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """POST with retry on transient failures."""
        url = f"{self._base_url}{path}"
        request_id = uuid.uuid4().hex[:12]
        headers = {"X-Request-ID": request_id}

        for attempt in range(1 + self._max_retries):
            try:
                response = await self._client.post(url, json=payload, headers=headers)
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
                ) from exc
            except httpx.HTTPError as exc:
                raise AtlaSentError(f"Request failed: {exc}", code="network") from exc

            if response.status_code == 429:
                retry_after = _parse_retry_after(response)
                raise RateLimitError(retry_after=retry_after)
            if response.status_code == 401:
                raise AtlaSentError(
                    "Invalid API key", status_code=401, code="invalid_api_key"
                )
            if response.status_code == 403:
                raise AtlaSentError(
                    "Access forbidden — check your API key permissions",
                    status_code=403,
                    code="forbidden",
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
                )
            if response.status_code >= 400:
                raise AtlaSentError(
                    f"API error {response.status_code}: {response.text[:500]}",
                    status_code=response.status_code,
                    code="bad_request",
                )

            try:
                return response.json()
            except ValueError as exc:
                raise AtlaSentError(
                    "Invalid JSON response from AtlaSent API",
                    code="bad_response",
                ) from exc

        raise AtlaSentError(
            f"Request to {path} failed after {1 + self._max_retries} attempts",
            code="network",
        )

    async def _backoff(self, attempt: int) -> None:
        delay = self._retry_backoff * (2**attempt)
        logger.debug("Retrying in %.1fs… (async)", delay)
        await asyncio.sleep(delay)


def _parse_retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None
