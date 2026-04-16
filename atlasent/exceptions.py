"""AtlaSent SDK exceptions."""


class AtlaSentError(Exception):
    """Base exception for all AtlaSent SDK errors."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(self.message)


class PermissionDeniedError(AtlaSentError):
    """Raised when an action is explicitly denied by AtlaSent."""

    def __init__(self, reason: str, decision_id: str) -> None:
        self.reason = reason
        self.decision_id = decision_id
        super().__init__(f"Permission denied: {reason}")


class ConfigurationError(AtlaSentError):
    """Raised when the SDK is misconfigured (e.g., missing API key)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
