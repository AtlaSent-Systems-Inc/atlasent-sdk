"""Synchronous AtlaSent API client (httpx-based)."""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any

import httpx

from ._version import __version__
from .exceptions import (
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    PermissionDeniedError,
    RateLimitError,
)
from .models import (
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
        self._api_key = api_key
        self._anon_key = anon_key
        self._base_url = base_url.rstrip("/")
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
    ) -> EvaluateResult:
        """Evaluate whether an action is authorized.

        Returns an :class:`EvaluateResult` on permit.
        Raises :class:`AtlaSentDenied` on deny (fail-closed).

        Args:
            action_type: The action to authorize (e.g. ``"modify_patient_record"``).
            actor_id: Identifier of the actor (agent or user).
            context: Arbitrary context dict for policy evaluation.

        Raises:
            AtlaSentDenied: The action was explicitly denied.
            AtlaSentError: Network error, timeout, or unexpected response.
            RateLimitError: HTTP 429.
        """
        ctx = context or {}

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
            api_key=self._api_key,
        )
        logger.debug("evaluate action=%r actor=%r", action_type, actor_id)
        data, rate_limit, request_id = self._post(
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

    def verify(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context: dict[str, Any] | None = None,
    ) -> VerifyResult:
        """Verify a previously issued permit token.

        Args:
            permit_token: The token from :meth:`evaluate`.
            action_type: Optionally re-state the action for cross-check.
            actor_id: Optionally re-state the actor for cross-check.
            context: Optionally re-state context for cross-check.

        Returns:
            A :class:`VerifyResult`.

        Raises:
            AtlaSentError: Network error, timeout, or unexpected response.
            RateLimitError: HTTP 429.
        """
        req = VerifyRequest(
            permit_token=permit_token,
            action_type=action_type,
            actor_id=actor_id,
            context=context or {},
            api_key=self._api_key,
        )
        logger.debug("verify token=%s", permit_token)
        data, rate_limit, request_id = self._post(
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

    # ── internals ─────────────────────────────────────────────────

    def _post(
        self, path: str, payload: dict[str, Any]
    ) -> tuple[dict[str, Any], RateLimitState | None, str]:
        """POST with retry on transient failures (5xx, timeouts).

        Returns ``(body, rate_limit, request_id)`` — rate_limit is parsed
        from ``X-RateLimit-*`` headers on the response, or ``None`` when
        the server doesn't emit them.
        """
        url = f"{self._base_url}{path}"
        request_id = uuid.uuid4().hex[:12]
        headers = {"X-Request-ID": request_id}

        for attempt in range(1 + self._max_retries):
            try:
                response = self._client.post(url, json=payload, headers=headers)
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

        raise AtlaSentError(
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
    if parsed.tzinfo is None:
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
