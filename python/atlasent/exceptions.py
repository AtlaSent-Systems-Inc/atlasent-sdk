from __future__ import annotations

from .models import EvaluateResponse


class AtlaSentError(Exception):
    """Base class for all AtlaSent SDK errors."""


class AtlaSentDeniedError(AtlaSentError):
    def __init__(self, code: str, response: EvaluateResponse) -> None:
        super().__init__(f"Authorization denied: {code}")
        self.code = code
        self.response = response


class AtlaSentHoldError(AtlaSentError):
    def __init__(self, code: str, response: EvaluateResponse) -> None:
        super().__init__(f"Authorization held: {code}")
        self.code = code
        self.response = response


class AtlaSentEscalateError(AtlaSentError):
    def __init__(self, escalate_to: str, response: EvaluateResponse) -> None:
        super().__init__(f"Authorization requires escalation to: {escalate_to}")
        self.escalate_to = escalate_to
        self.response = response


class AtlaSentAPIError(AtlaSentError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"AtlaSent API error {status}: {message}")
        self.status = status
        self.message = message
