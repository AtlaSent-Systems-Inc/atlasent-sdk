"""AtlaSent SDK exceptions.

The SDK follows a **fail-closed** design: any failure to confirm authorization
raises, ensuring no action proceeds without an explicit permit.
"""

from __future__ import annotations

from typing import Any, Literal

from .models import EvaluateResponse, VerifyPermitResponse

AtlaSentErrorCode = Literal[
    "invalid_api_key",
    "forbidden",
    "rate_limited",
    "timeout",
    "network",
    "bad_response",
    "bad_request",
    "server_error",
    "unavailable",
]
"""Coarse error category -- shared across AtlaSent SDKs."""


class AtlaSentError(Exception):
    """Base exception for all AtlaSent SDK errors."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: AtlaSentErrorCode | None = None,
        response_body: dict[str, Any] | None = None,
    ) -> None:
        self.message = message
        self.status_code = status_code
        self.code: AtlaSentErrorCode | None = code
        self.response_body = response_body
        super().__init__(self.message)


class AuthorizationUnavailableError(AtlaSentError):
    """The SDK could not reach AtlaSent, got a malformed response, or timed out.

    Fail-closed callers MUST NOT proceed with the action on this error.
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        response_body: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            message,
            status_code=status_code,
            code="unavailable",
            response_body=response_body,
        )


class AuthorizationDeniedError(AtlaSentError):
    """The server said no. Decision is one of ``deny | hold | escalate``.

    Raised by :meth:`AtlaSentClient.authorize` and :meth:`AtlaSentClient.with_permit`
    to block execution. Carries the full :class:`EvaluateResponse` so callers can
    log ``deny_code`` / ``deny_reason`` / ``request_id``.
    """

    def __init__(self, response: EvaluateResponse) -> None:
        self.response = response
        parts = [f"atlasent {response.decision}"]
        if response.deny_code:
            parts.append(response.deny_code)
        if response.deny_reason:
            parts.append(response.deny_reason)
        super().__init__(": ".join(parts), code="forbidden")

    @property
    def decision(self) -> str:
        return self.response.decision

    @property
    def deny_code(self) -> str | None:
        return self.response.deny_code

    @property
    def deny_reason(self) -> str | None:
        return self.response.deny_reason

    @property
    def request_id(self) -> str:
        return self.response.request_id


class PermitVerificationError(AtlaSentError):
    """Permit verification denied execution.

    Carries the full :class:`VerifyPermitResponse` so callers can log
    ``verify_error_code``. Raised by :meth:`AtlaSentClient.with_permit`.
    """

    def __init__(
        self,
        message: str,
        *,
        response: VerifyPermitResponse | None = None,
    ) -> None:
        self.response = response
        super().__init__(message, code="forbidden")

    @property
    def verify_error_code(self) -> str | None:
        return self.response.verify_error_code if self.response else None


class ConfigurationError(AtlaSentError):
    """Raised when the SDK is misconfigured (e.g., missing API key)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


class RateLimitError(AtlaSentError):
    """Raised when the API returns HTTP 429 (Too Many Requests)."""

    def __init__(self, retry_after: float | None = None) -> None:
        self.retry_after = retry_after
        msg = "Rate limited by AtlaSent API"
        if retry_after is not None:
            msg += f" -- retry after {retry_after}s"
        super().__init__(msg, status_code=429, code="rate_limited")
