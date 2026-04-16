"""Async AtlaSent API client using httpx."""

import asyncio
import logging
from typing import Any, Optional

try:
    import httpx
except ImportError:  # pragma: no cover
    httpx = None  # type: ignore[assignment]

from ._version import __version__ as SDK_VERSION
from .config import DEFAULT_BASE_URL, get_api_key
from .exceptions import AtlaSentError, RateLimitError
from .models import AuthorizationResult

logger = logging.getLogger("atlasent")

DEFAULT_TIMEOUT = 10
DEFAULT_MAX_RETRIES = 2
DEFAULT_RETRY_BACKOFF = 0.5


def _require_httpx() -> None:
    if httpx is None:
        raise ImportError(
            "httpx is required for the async client. "
            "Install it with: pip install atlasent[async]"
        )


class AsyncAtlaSentClient:
    """Async client for the AtlaSent authorization API.

    Requires the ``httpx`` package. Install with::

        pip install atlasent[async]

    Args:
        api_key: Your AtlaSent API key. If not provided, the global
            configuration or ATLASENT_API_KEY environment variable is used.
        environment: Deployment environment name. Defaults to "production".
        base_url: Override the base API URL. Defaults to
            https://api.atlasent.io.
        timeout: Request timeout in seconds. Defaults to 10.
        max_retries: Maximum number of retries on transient errors.
            Defaults to 2.
        retry_backoff: Base backoff time in seconds between retries.
            Doubles after each attempt. Defaults to 0.5.

    Supports the async context manager protocol::

        async with AsyncAtlaSentClient(api_key="ask_live_...") as client:
            result = await client.evaluate("my-agent", "read_data")
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        environment: str = "production",
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_backoff: float = DEFAULT_RETRY_BACKOFF,
    ) -> None:
        _require_httpx()
        self._api_key = api_key
        self._environment = environment
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff
        self._client = httpx.AsyncClient(
            headers={
                "Content-Type": "application/json",
                "User-Agent": f"atlasent-python/{SDK_VERSION}",
            },
            timeout=self._timeout,
        )

    @property
    def api_key(self) -> str:
        """Resolve the API key from the instance, global config, or env var."""
        if self._api_key:
            return self._api_key
        return get_api_key()

    async def evaluate(
        self,
        agent: str,
        action: str,
        context: Optional[dict[str, Any]] = None,
    ) -> AuthorizationResult:
        """Evaluate whether an agent action is authorized.

        Args:
            agent: Identifier of the AI agent requesting authorization.
            action: The action the agent wants to perform.
            context: Optional dictionary of additional context for the
                authorization decision.

        Returns:
            An AuthorizationResult indicating whether the action is permitted.

        Raises:
            AtlaSentError: On network errors, timeouts, or unexpected
                API responses.
            RateLimitError: When the API returns HTTP 429.
        """
        payload = {
            "agent": agent,
            "action": action,
            "context": context or {},
            "api_key": self.api_key,
        }
        logger.debug("Evaluating action=%r for agent=%r (async)", action, agent)
        data = await self._post("/v1-evaluate", payload)
        result = AuthorizationResult(
            permitted=data["permitted"],
            decision_id=data["decision_id"],
            reason=data["reason"],
            audit_hash=data["audit_hash"],
            timestamp=data["timestamp"],
        )
        if result.permitted:
            logger.info(
                "Action %r permitted for agent %r (decision=%s)",
                action,
                agent,
                result.decision_id,
            )
        else:
            logger.info(
                "Action %r denied for agent %r: %s (decision=%s)",
                action,
                agent,
                result.reason,
                result.decision_id,
            )
        return result

    async def verify_permit(self, decision_id: str) -> dict:
        """Verify a previously issued permit.

        Args:
            decision_id: The decision ID returned by a prior evaluate() call.

        Returns:
            A dictionary containing ``verified``, ``permit_hash``, and
            ``timestamp`` fields.

        Raises:
            AtlaSentError: On network errors, timeouts, or unexpected
                API responses.
            RateLimitError: When the API returns HTTP 429.
        """
        payload = {
            "decision_id": decision_id,
            "api_key": self.api_key,
        }
        logger.debug("Verifying permit for decision=%s (async)", decision_id)
        return await self._post("/v1-verify-permit", payload)

    async def close(self) -> None:
        """Close the underlying HTTP client and release resources."""
        await self._client.aclose()
        logger.debug("AsyncAtlaSentClient session closed")

    async def __aenter__(self) -> "AsyncAtlaSentClient":
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb) -> None:  # noqa: ANN001
        await self.close()

    async def _post(self, path: str, payload: dict) -> dict:
        """Send a POST request with retry logic."""
        url = f"{self._base_url}{path}"

        for attempt in range(1 + self._max_retries):
            try:
                response = await self._client.post(url, json=payload)
            except httpx.TimeoutException as exc:
                logger.warning(
                    "Request to %s timed out (attempt %d/%d)",
                    path,
                    attempt + 1,
                    1 + self._max_retries,
                )
                if attempt < self._max_retries:
                    await self._backoff(attempt)
                    continue
                raise AtlaSentError(
                    f"Request to {path} timed out after "
                    f"{1 + self._max_retries} attempts"
                ) from exc
            except httpx.ConnectError as exc:
                logger.warning(
                    "Connection to %s failed (attempt %d/%d): %s",
                    self._base_url,
                    attempt + 1,
                    1 + self._max_retries,
                    exc,
                )
                if attempt < self._max_retries:
                    await self._backoff(attempt)
                    continue
                raise AtlaSentError(
                    f"Failed to connect to AtlaSent API at "
                    f"{self._base_url} after {1 + self._max_retries} attempts"
                ) from exc
            except httpx.HTTPError as exc:
                raise AtlaSentError(f"Request failed: {exc}") from exc

            if response.status_code == 429:
                retry_after = self._parse_retry_after(response)
                logger.warning(
                    "Rate limited on %s (retry_after=%s)", path, retry_after
                )
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
                    "Server error %d on %s (attempt %d/%d)",
                    response.status_code,
                    path,
                    attempt + 1,
                    1 + self._max_retries,
                )
                if attempt < self._max_retries:
                    await self._backoff(attempt)
                    continue
                raise AtlaSentError(
                    f"API error {response.status_code}: "
                    f"{response.text[:500]}",
                    status_code=response.status_code,
                )

            if response.status_code >= 400:
                raise AtlaSentError(
                    f"API error {response.status_code}: "
                    f"{response.text[:500]}",
                    status_code=response.status_code,
                )

            try:
                return response.json()
            except ValueError as exc:
                raise AtlaSentError(
                    "Invalid JSON response from AtlaSent API"
                ) from exc

        raise AtlaSentError(
            f"Request to {path} failed after {1 + self._max_retries} attempts"
        )

    async def _backoff(self, attempt: int) -> None:
        """Sleep with exponential backoff."""
        delay = self._retry_backoff * (2**attempt)
        logger.debug("Retrying in %.1fs... (async)", delay)
        await asyncio.sleep(delay)

    @staticmethod
    def _parse_retry_after(response: "httpx.Response") -> float | None:
        """Parse the Retry-After header from a 429 response."""
        value = response.headers.get("retry-after")
        if value is None:
            return None
        try:
            return float(value)
        except (ValueError, TypeError):
            return None
