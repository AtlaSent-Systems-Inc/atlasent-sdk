"""Synchronous AtlaSent API client (httpx-based)."""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, TypeVar

import httpx

from ._version import __version__
from .exceptions import (
    AuthorizationDeniedError,
    AuthorizationUnavailableError,
    PermitVerificationError,
    RateLimitError,
)
from .models import (
    EvaluateRequest,
    EvaluateResponse,
    VerifyPermitRequest,
    VerifyPermitResponse,
    is_allowed,
)

if TYPE_CHECKING:
    from .cache import TTLCache

logger = logging.getLogger("atlasent")

DEFAULT_BASE_URL = "https://api.atlasent.io"
DEFAULT_TIMEOUT = 10
DEFAULT_MAX_RETRIES = 2
DEFAULT_RETRY_BACKOFF = 0.5

T = TypeVar("T")


class AtlaSentClient:
    """Synchronous client for the AtlaSent execution-time authorization API.

    The client is **fail-closed**: any failure to reach a definitive ``allow``
    decision raises, so no action proceeds without an explicit permit.

    Args:
        api_key: Your AtlaSent API key. Sent as ``Authorization: Bearer ...``.
        base_url: Override the API base URL.
        timeout: HTTP request timeout in seconds.
        max_retries: Retries on transient errors (5xx, timeouts).
        retry_backoff: Base backoff in seconds (doubles each retry).
        cache: Optional :class:`TTLCache` for caching successful evaluate
            responses. Denials, hold, and escalate are not cached.

    Endpoints used::

        POST {base_url}/v1-evaluate
        POST {base_url}/v1-verify-permit

    Usage::

        from atlasent import AtlaSentClient, EvaluateRequest

        with AtlaSentClient(api_key="ak_...") as client:
            res = client.authorize(EvaluateRequest(
                action_type="payment.transfer",
                actor_id="user:42",
                context={"amount": 1000},
            ))
            # res.decision == "allow"; res.permit_token is set.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_backoff: float = DEFAULT_RETRY_BACKOFF,
        cache: TTLCache | None = None,
    ) -> None:
        self._api_key = api_key
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

    def evaluate(self, request: EvaluateRequest) -> EvaluateResponse:
        """Ask the server whether an action should be allowed right now.

        Returns the full :class:`EvaluateResponse` on every decision
        (``allow`` / ``deny`` / ``hold`` / ``escalate``). Does not raise on
        non-allow -- callers that want fail-closed enforcement should use
        :meth:`authorize` or :meth:`with_permit`.

        Raises:
            AuthorizationUnavailableError: Network, timeout, malformed body,
                auth failure, or server error. Callers MUST NOT proceed.
            RateLimitError: HTTP 429.
        """
        payload = request.model_dump(exclude_none=True)

        cache_key: str | None = None
        if self._cache is not None:
            from .cache import TTLCache

            cache_key = TTLCache.make_key(
                request.action_type, request.actor_id, request.context
            )
            cached = self._cache.get(cache_key)
            if cached is not None:
                logger.debug("evaluate cache hit for %s", cache_key)
                return cached

        logger.debug(
            "evaluate action_type=%r actor_id=%r", request.action_type, request.actor_id
        )
        data = self._post("/v1-evaluate", payload)
        try:
            response = EvaluateResponse.model_validate(data)
        except Exception as exc:  # pydantic ValidationError
            raise AuthorizationUnavailableError(
                "Malformed /v1-evaluate response body",
                response_body=data,
            ) from exc

        logger.info(
            "evaluate decision=%s action_type=%r actor_id=%r request_id=%s",
            response.decision,
            request.action_type,
            request.actor_id,
            response.request_id,
        )

        if cache_key is not None and response.decision == "allow":
            assert self._cache is not None
            self._cache.put(cache_key, response)

        return response

    def verify_permit(self, request: VerifyPermitRequest) -> VerifyPermitResponse:
        """Verify (consume) a permit. Value-based: never raises on ``valid: false``.

        The caller MUST inspect ``response.valid`` and ``response.outcome``.
        HTTP status is not authoritative -- the server returns a value-based
        envelope even for 400/401/403/429 paths.

        Raises:
            AuthorizationUnavailableError: Network / timeout / malformed body.
        """
        payload = request.model_dump(exclude_none=True)
        logger.debug("verify_permit token=%s", request.permit_token)
        data = self._post("/v1-verify-permit", payload, treat_4xx_as_body=True)
        try:
            response = VerifyPermitResponse.model_validate(data)
        except Exception as exc:
            raise AuthorizationUnavailableError(
                "Malformed /v1-verify-permit response body",
                response_body=data,
            ) from exc
        logger.info(
            "verify_permit token=%s valid=%s outcome=%s",
            request.permit_token,
            response.valid,
            response.outcome,
        )
        return response

    def authorize(self, request: EvaluateRequest) -> EvaluateResponse:
        """Evaluate and raise unless the decision is ``allow``.

        Raises:
            AuthorizationDeniedError: ``deny`` / ``hold`` / ``escalate``.
            AuthorizationUnavailableError: Network / timeout / bad body.
            RateLimitError: HTTP 429.
        """
        response = self.evaluate(request)
        if not is_allowed(response.decision):
            raise AuthorizationDeniedError(response)
        return response

    def with_permit(
        self,
        request: EvaluateRequest,
        fn: Callable[[EvaluateResponse, VerifyPermitResponse], T],
    ) -> T:
        """Evaluate -> require ``allow`` -> verify+consume the permit (value-based
        fail-closed) -> run ``fn``.

        ``fn`` is unreachable unless the server issued a permit and verification
        explicitly succeeded. The permit verification binds to the same
        ``actor_id`` and ``action_type`` as the evaluation, so a permit lifted
        from one flow cannot be replayed in another.

        Raises:
            AuthorizationDeniedError: ``deny`` / ``hold`` / ``escalate``.
            PermitVerificationError: Server issued permit but verification
                denied execution (expired, revoked, already used, binding
                mismatch, etc.).
            AuthorizationUnavailableError: Network / timeout / bad body.
        """
        evaluation = self.authorize(request)
        if not evaluation.permit_token:
            raise PermitVerificationError(
                f"server returned decision=allow but no permit_token "
                f"(request_id={evaluation.request_id}); refusing to execute"
            )
        verification = self.verify_permit(
            VerifyPermitRequest(
                permit_token=evaluation.permit_token,
                actor_id=request.actor_id,
                action_type=request.action_type,
            )
        )
        if not verification.valid or verification.outcome != "allow":
            raise PermitVerificationError(
                f"permit verification denied "
                f"({verification.verify_error_code or 'UNKNOWN'}): {verification.reason}",
                response=verification,
            )
        return fn(evaluation, verification)

    # ── lifecycle ─────────────────────────────────────────────────

    def close(self) -> None:
        self._client.close()
        logger.debug("AtlaSentClient closed")

    def __enter__(self) -> AtlaSentClient:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:  # noqa: ANN001
        self.close()

    # ── internals ─────────────────────────────────────────────────

    def _post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        treat_4xx_as_body: bool = False,
    ) -> dict[str, Any]:
        """POST with retry on transient failures.

        Status handling:
          - 2xx: return body.
          - 429: raise :class:`RateLimitError`.
          - 5xx / timeouts / network errors: retry; then raise
            :class:`AuthorizationUnavailableError`.
          - Other 4xx: raise :class:`AuthorizationUnavailableError` UNLESS
            ``treat_4xx_as_body=True`` (used by verify-permit, which returns a
            value-based envelope on 4xx paths too).
        """
        url = f"{self._base_url}{path}"
        request_id = uuid.uuid4().hex[:12]
        headers = {"X-Request-ID": request_id}

        last_error: Exception | None = None
        for attempt in range(1 + self._max_retries):
            try:
                response = self._client.post(url, json=payload, headers=headers)
            except httpx.TimeoutException as exc:
                last_error = exc
                logger.warning(
                    "%s timeout (attempt %d/%d)",
                    path,
                    attempt + 1,
                    1 + self._max_retries,
                )
                if attempt < self._max_retries:
                    self._backoff(attempt)
                    continue
                raise AuthorizationUnavailableError(
                    f"Request to {path} timed out after {1 + self._max_retries} attempts"
                ) from exc
            except (httpx.ConnectError, httpx.HTTPError) as exc:
                last_error = exc
                logger.warning(
                    "%s connection failed (attempt %d/%d): %s",
                    self._base_url,
                    attempt + 1,
                    1 + self._max_retries,
                    exc,
                )
                if attempt < self._max_retries:
                    self._backoff(attempt)
                    continue
                raise AuthorizationUnavailableError(
                    f"Failed to reach AtlaSent at {self._base_url}: {exc}"
                ) from exc

            if response.status_code == 429:
                raise RateLimitError(retry_after=_parse_retry_after(response))
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
                raise AuthorizationUnavailableError(
                    f"API error {response.status_code}: {response.text[:500]}",
                    status_code=response.status_code,
                )
            if 200 <= response.status_code < 300 or (
                treat_4xx_as_body and 400 <= response.status_code < 500
            ):
                try:
                    return response.json()
                except ValueError as exc:
                    raise AuthorizationUnavailableError(
                        f"Invalid JSON response from {path}",
                        status_code=response.status_code,
                    ) from exc
            # 4xx without treat_4xx_as_body: surface server's structured error.
            body = _safe_json(response)
            raise AuthorizationUnavailableError(
                _format_error(response.status_code, body),
                status_code=response.status_code,
                response_body=body,
            )

        # Unreachable: retry loop either returns, raises, or keeps going.
        raise AuthorizationUnavailableError(
            f"Request to {path} failed after {1 + self._max_retries} attempts"
        ) from last_error

    def _backoff(self, attempt: int) -> None:
        delay = self._retry_backoff * (2**attempt)
        logger.debug("Retrying in %.1fs", delay)
        time.sleep(delay)


def _safe_json(response: httpx.Response) -> dict[str, Any] | None:
    try:
        body = response.json()
    except ValueError:
        return None
    return body if isinstance(body, dict) else None


def _format_error(status: int, body: dict[str, Any] | None) -> str:
    if body:
        code = body.get("error_code") or "UNKNOWN"
        reason = body.get("reason") or ""
        return f"API error {status}: {code} -- {reason}"
    return f"API error {status}"


def _parse_retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None
