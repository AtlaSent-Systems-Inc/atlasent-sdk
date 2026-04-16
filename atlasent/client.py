"""Synchronous AtlaSent API client (httpx-based)."""

from __future__ import annotations

import logging
import time
from typing import Any

import httpx

from ._version import __version__
from .exceptions import AtlaSentDenied, AtlaSentError, RateLimitError
from .models import (
    EvaluateRequest,
    EvaluateResult,
    GateResult,
    VerifyRequest,
    VerifyResult,
)

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
    ) -> None:
        self._api_key = api_key
        self._anon_key = anon_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff
        self._client = httpx.Client(
            headers={
                "Content-Type": "application/json",
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
        req = EvaluateRequest(
            action_type=action_type,
            actor_id=actor_id,
            context=context or {},
            api_key=self._api_key,
        )
        logger.debug("evaluate action=%r actor=%r", action_type, actor_id)
        data = self._post("/v1-evaluate", req.model_dump(by_alias=True))

        permitted = data.get("permitted")
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
        data = self._post("/v1-verify-permit", req.model_dump(by_alias=True))
        result = VerifyResult.model_validate(data)
        logger.info("verify token=%s valid=%s", permit_token, result.valid)
        return result

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

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        """POST with retry on transient failures (5xx, timeouts)."""
        url = f"{self._base_url}{path}"

        for attempt in range(1 + self._max_retries):
            try:
                response = self._client.post(url, json=payload)
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
                    f"{1 + self._max_retries} attempts"
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
                    f"{self._base_url} after {1 + self._max_retries} attempts"
                ) from exc
            except httpx.HTTPError as exc:
                raise AtlaSentError(f"Request failed: {exc}") from exc

            if response.status_code == 429:
                retry_after = _parse_retry_after(response)
                raise RateLimitError(retry_after=retry_after)
            if response.status_code == 401:
                raise AtlaSentError("Invalid API key", status_code=401)
            if response.status_code == 403:
                raise AtlaSentError(
                    "Access forbidden — check your API key permissions",
                    status_code=403,
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
                    f"API error {response.status_code}: " f"{response.text[:500]}",
                    status_code=response.status_code,
                )
            if response.status_code >= 400:
                raise AtlaSentError(
                    f"API error {response.status_code}: " f"{response.text[:500]}",
                    status_code=response.status_code,
                )

            try:
                return response.json()
            except ValueError as exc:
                raise AtlaSentError("Invalid JSON response from AtlaSent API") from exc

        raise AtlaSentError(
            f"Request to {path} failed after {1 + self._max_retries} attempts"
        )

    def _backoff(self, attempt: int) -> None:
        delay = self._retry_backoff * (2**attempt)
        logger.debug("Retrying in %.1fs…", delay)
        time.sleep(delay)


def _parse_retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        return float(value)
    except (ValueError, TypeError):
        return None
