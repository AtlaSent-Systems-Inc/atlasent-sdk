"""AtlaSent API client."""

from typing import Any, Optional

import requests

from .config import DEFAULT_BASE_URL, get_api_key
from .exceptions import AtlaSentError
from .models import AuthorizationResult

SDK_VERSION = "0.1.0"
REQUEST_TIMEOUT = 10


class AtlaSentClient:
    """Client for the AtlaSent authorization API.

    Args:
        api_key: Your AtlaSent API key. If not provided, the global
            configuration or ATLASENT_API_KEY environment variable is used.
        environment: Deployment environment name. Defaults to "production".
        base_url: Override the base API URL. Defaults to
            https://api.atlasent.io.
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        environment: str = "production",
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        self._api_key = api_key
        self._environment = environment
        self._base_url = base_url.rstrip("/")
        self._session = requests.Session()
        self._session.headers.update(
            {
                "Content-Type": "application/json",
                "User-Agent": f"atlasent-python/{SDK_VERSION}",
            }
        )

    @property
    def api_key(self) -> str:
        """Resolve the API key from the instance, global config, or env var."""
        if self._api_key:
            return self._api_key
        return get_api_key()

    def evaluate(
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
                authorization decision (e.g., patient ID, study phase).

        Returns:
            An AuthorizationResult indicating whether the action is permitted.

        Raises:
            AtlaSentError: On network errors, timeouts, or unexpected
                API responses.
        """
        payload = {
            "agent": agent,
            "action": action,
            "context": context or {},
            "api_key": self.api_key,
        }
        data = self._post("/v1-evaluate", payload)
        return AuthorizationResult(
            permitted=data["permitted"],
            decision_id=data["decision_id"],
            reason=data["reason"],
            audit_hash=data["audit_hash"],
            timestamp=data["timestamp"],
        )

    def verify_permit(self, decision_id: str) -> dict:
        """Verify a previously issued permit.

        Args:
            decision_id: The decision ID returned by a prior evaluate() call.

        Returns:
            A dictionary containing ``verified``, ``permit_hash``, and
            ``timestamp`` fields.

        Raises:
            AtlaSentError: On network errors, timeouts, or unexpected
                API responses.
        """
        payload = {
            "decision_id": decision_id,
            "api_key": self.api_key,
        }
        return self._post("/v1-verify-permit", payload)

    def _post(self, path: str, payload: dict) -> dict:
        """Send a POST request and return the parsed JSON response."""
        url = f"{self._base_url}{path}"
        try:
            response = self._session.post(
                url, json=payload, timeout=REQUEST_TIMEOUT
            )
        except requests.exceptions.Timeout as exc:
            raise AtlaSentError(
                f"Request to {path} timed out after {REQUEST_TIMEOUT}s"
            ) from exc
        except requests.exceptions.ConnectionError as exc:
            raise AtlaSentError(
                f"Failed to connect to AtlaSent API at {self._base_url}: {exc}"
            ) from exc
        except requests.exceptions.RequestException as exc:
            raise AtlaSentError(f"Request failed: {exc}") from exc

        if response.status_code == 401:
            raise AtlaSentError("Invalid API key", status_code=401)
        if response.status_code == 403:
            raise AtlaSentError(
                "Access forbidden — check your API key permissions",
                status_code=403,
            )
        if response.status_code >= 400:
            raise AtlaSentError(
                f"API error {response.status_code}: {response.text}",
                status_code=response.status_code,
            )

        try:
            return response.json()
        except ValueError as exc:
            raise AtlaSentError(
                "Invalid JSON response from AtlaSent API"
            ) from exc
