"""AtlaSent SDK exceptions."""


class AtlaSentError(Exception):
    """Base exception for all AtlaSent SDK errors."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(self.message)


class PermissionDeniedError(AtlaSentError):
    """Raised when an action is explicitly denied by AtlaSent.

    Attributes:
        reason: Human-readable explanation of why the action was denied.
        decision_id: The unique identifier for this authorization decision.
        audit_hash: The audit trail hash for this decision.
    """

    def __init__(self, reason: str, decision_id: str, audit_hash: str = "") -> None:
        self.reason = reason
        self.decision_id = decision_id
        self.audit_hash = audit_hash
        super().__init__(f"Permission denied: {reason}")


class ConfigurationError(AtlaSentError):
    """Raised when the SDK is misconfigured (e.g., missing API key)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


class RateLimitError(AtlaSentError):
    """Raised when the API returns HTTP 429 (Too Many Requests).

    Attributes:
        retry_after: Seconds to wait before retrying, parsed from the
            Retry-After header. ``None`` if the header was absent.
    """

    def __init__(self, retry_after: float | None = None) -> None:
        self.retry_after = retry_after
        msg = "Rate limited by AtlaSent API"
        if retry_after is not None:
            msg += f" — retry after {retry_after}s"
        super().__init__(msg, status_code=429)
