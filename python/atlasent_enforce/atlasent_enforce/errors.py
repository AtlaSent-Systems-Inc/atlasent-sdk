from __future__ import annotations


class DisallowedConfigError(Exception):
    """Raised when an Enforce config violates a non-toggleable invariant."""


class LatencyBreachError(Exception):
    """Raised internally when the latency budget is breached in deny mode."""


def classify_client_error(err: Exception, fallback: str) -> str:
    """Return a ReasonCode string by inspecting a client-thrown exception."""
    reason_code = getattr(err, "reason_code", None)
    if isinstance(reason_code, str) and reason_code:
        return reason_code

    http_status = getattr(err, "http_status", None)
    if isinstance(http_status, int):
        if 400 <= http_status < 500:
            return fallback.replace("_unavailable", "_client_error")
        return fallback

    return fallback
