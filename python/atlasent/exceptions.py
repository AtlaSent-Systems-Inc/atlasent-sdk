"""AtlaSent SDK exceptions.

The SDK follows a **fail-closed** design: any failure to confirm
authorization raises an exception, ensuring no action proceeds
without an explicit permit.
"""

from __future__ import annotations

from typing import Any, Literal

AtlaSentDecision = Literal["deny", "hold", "escalate"]
"""Policy decision outcomes on a denial.

``"deny"`` is what the current ``/v1-evaluate`` API returns. ``"hold"``
and ``"escalate"`` are reserved for forthcoming API decisions that
put a permit into a pending state requiring human review; the union
is declared now so call sites can ``match`` exhaustively from the
start and adopt new decisions without a breaking change.
"""

AtlaSentErrorCode = Literal[
    "invalid_api_key",
    "forbidden",
    "rate_limited",
    "timeout",
    "network",
    "bad_response",
    "bad_request",
    "server_error",
]
"""Coarse error category — shared across AtlaSent SDKs.

Call sites MAY ``switch`` / ``match`` on this field. The set is
defined by ``contract/vectors/errors.json`` in the SDK repo; any new
code MUST be added there first.
"""


class AtlaSentError(Exception):
    """Base exception for all AtlaSent SDK errors.

    Raised on network failures, timeouts, malformed responses,
    configuration errors, and any other unexpected condition.
    Because the SDK is fail-closed, an ``AtlaSentError`` means
    the action must NOT proceed.

    Attributes:
        message: Human-readable error message.
        status_code: HTTP status code when the error originated from
            an API response. ``None`` for transport errors.
        code: Coarse category from :data:`AtlaSentErrorCode`.
            ``None`` only on the deprecated legacy construction path;
            every raise site inside the SDK sets it.
        response_body: Decoded JSON body when available.
    """

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


class AtlaSentDenied(AtlaSentError):
    """Raised when the AtlaSent API explicitly denies an action.

    This is the normal "not permitted" path.  Callers should catch
    this to handle denied actions gracefully (e.g., log an audit
    event, return a 403 to the user).

    Attributes:
        decision: The decision string returned by the API (e.g. ``"deny"``).
        permit_token: The token associated with this evaluation, if any.
        reason: Human-readable explanation, when provided by the API.
    """

    def __init__(
        self,
        decision: str,
        *,
        permit_token: str = "",
        reason: str = "",
        response_body: dict[str, Any] | None = None,
    ) -> None:
        self.decision = decision
        self.permit_token = permit_token
        self.reason = reason
        msg = f"Action denied: {decision}"
        if reason:
            msg += f" — {reason}"
        super().__init__(msg, response_body=response_body)


class ConfigurationError(AtlaSentError):
    """Raised when the SDK is misconfigured (e.g., missing API key)."""

    def __init__(self, message: str) -> None:
        super().__init__(message)


class PermissionDeniedError(AtlaSentDenied):
    """Raised when ``authorize(..., raise_on_deny=True)`` is denied.

    Alias-style subclass of :class:`AtlaSentDenied` that reads more
    naturally in authorization-centric code paths.
    """


class AtlaSentDeniedError(AtlaSentDenied):
    """Raised by :func:`atlasent.protect` when the policy engine
    refuses the action, or when the resulting permit fails
    end-to-end verification.

    This is the **fail-closed boundary** of ``protect()``: every
    code path that short-circuits an action because authorization
    was not confirmed raises ``AtlaSentDeniedError``. Callers cannot
    silently proceed on a denial by forgetting to branch on a
    return value.

    Shape mirrors the TypeScript SDK's ``AtlaSentDeniedError`` for
    cross-language parity. Subclasses :class:`AtlaSentDenied` so
    existing ``except AtlaSentDenied:`` catches ``protect()``
    denials too; use ``except AtlaSentDeniedError:`` to distinguish
    a policy denial from the older ``authorize()`` /
    ``evaluate()`` denial surface.

    Attributes:
        decision: Policy outcome — ``"deny"`` today; ``"hold"`` /
            ``"escalate"`` reserved for forthcoming API responses.
        evaluation_id: Opaque permit / decision identifier (echo of
            the inherited ``permit_token`` field, named for parity
            with the TypeScript SDK).
        reason: Human-readable explanation from the policy engine.
        audit_hash: Hash-chained audit-trail entry associated with
            the decision, if present on the server response.
    """

    def __init__(
        self,
        *,
        decision: AtlaSentDecision = "deny",
        evaluation_id: str,
        reason: str = "",
        audit_hash: str = "",
        request_id: str | None = None,
    ) -> None:
        super().__init__(
            decision=decision,
            permit_token=evaluation_id,
            reason=reason,
        )
        self.evaluation_id = evaluation_id
        self.audit_hash = audit_hash
        # `request_id` lives on `AtlaSentError` in the TS SDK; Python's
        # AtlaSentError doesn't have a first-class request_id attribute
        # yet (that's a separate parity change — see finish-work), so
        # store it on this subclass for now.
        self.request_id = request_id


class RateLimitError(AtlaSentError):
    """Raised when the API returns HTTP 429 (Too Many Requests).

    Attributes:
        retry_after: Seconds to wait before retrying, parsed from the
            ``Retry-After`` header.  ``None`` if the header was absent.
    """

    def __init__(self, retry_after: float | None = None) -> None:
        self.retry_after = retry_after
        msg = "Rate limited by AtlaSent API"
        if retry_after is not None:
            msg += f" — retry after {retry_after}s"
        super().__init__(msg, status_code=429, code="rate_limited")
