"""Synchronous AtlaSent API client (httpx-based)."""

from __future__ import annotations

import logging
import os
import re
import time
import uuid
import warnings
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlparse

import httpx

from ._version import __version__
from .audit import AuditEventsResult, AuditExportResult
from .exceptions import (
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    PermissionDeniedError,
    RateLimitError,
    _normalize_permit_outcome,
)
from .approval_artifact import ApprovalReference
from .models import (
    ApiKeySelfResult,
    AuthorizationResult,
    ConstraintTrace,
    EvaluatePreflightResult,
    EvaluateRequest,
    EvaluateResult,
    GateResult,
    GetPermitResult,
    ListPermitsResult,
    Permit,
    PermitRecord,
    PermitVerifyEvidence,
    RateLimitState,
    RevokePermitByIdResult,
    RevokePermitResult,
    VerifyPermitByIdResult,
    VerifyRequest,
    VerifyResult,
)
from .hitl import (
    HitlApprovalsResult,
    HitlChainResult,
    HitlCreateRequest,
    HitlEscalation,
    HitlEscalationResult,
    HitlStatus,
    ListHitlEscalationsResult,
)

if TYPE_CHECKING:
    from .cache import TTLCache

logger = logging.getLogger("atlasent")

DEFAULT_BASE_URL = "https://api.atlasent.io"
DEFAULT_TIMEOUT = 10
# Retry schedule parity with the TypeScript SDK:
#   4 total attempts (1 initial + 3 retries), delays 2 s → 4 s → 8 s
#   (capped at 16 s) via the exponential formula:
#   delay = min(16, retry_backoff * 2**attempt)
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_BACKOFF = 2.0
_RETRY_MAX_DELAY = 16.0

# API-key prefix contract per atlasent-api/supabase/functions/_shared/auth.ts:
#   "ask_live_<entropy>" — production keys
#   "ask_test_<entropy>" — non-production keys
# Validated client-side so a mis-pasted key (with whitespace, quotes,
# or a leftover wrapping char) trips loudly at construction rather
# than yielding a 401 mid-conversation. The character class matches
# what atlasent-api accepts; widen here only if the server widens
# first.
_API_KEY_PATTERN = re.compile(r"^ask_(?:live|test)_[A-Za-z0-9_-]+$")


def _validate_api_key(api_key: str) -> str:
    """Reject obviously-malformed API keys at client init.

    Returns the trimmed key on accept; raises ``ValueError`` on
    reject. Never echoes the key into the error message — only the
    first 8 characters of any non-matching value, so a paste accident
    that copies the right side of the key doesn't surface in stderr.
    """
    if not isinstance(api_key, str) or not api_key:
        raise ValueError("AtlaSent api_key is required")
    if not _API_KEY_PATTERN.match(api_key):
        head = api_key[:8] if api_key else ""
        raise ValueError(
            f"AtlaSent api_key does not match expected shape "
            f"`ask_(live|test)_<entropy>` (got prefix={head!r}). "
            "Check for whitespace, quotes, or trailing characters."
        )
    return api_key


def _redact_token(token: str) -> str:
    """Render a permit/decision token safe to log.

    Returns ``"…<last 6>"`` so log lines correlate against the
    server-side audit trail without leaking enough material to replay
    a permit. ``""`` and short strings render as ``"…"``.
    """
    if not token:
        return "…"
    return "…" + token[-6:]


def _enforce_tls(base_url: str) -> str:
    """Reject non-TLS base URLs unless the dev escape hatch is set.

    `ATLASENT_ALLOW_INSECURE_HTTP=1` permits ``http://`` for local
    fixtures and unit tests that mock httpx — production callers never
    set this. Returns the URL unchanged on accept; raises ``ValueError``
    on reject.
    """
    if os.getenv("ATLASENT_ALLOW_INSECURE_HTTP") == "1":
        return base_url
    parsed = urlparse(base_url)
    if parsed.scheme and parsed.scheme != "https":
        raise ValueError(
            f"AtlaSent base_url must use https:// (got scheme={parsed.scheme!r}). "
            "For local development, set ATLASENT_ALLOW_INSECURE_HTTP=1."
        )
    return base_url


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
        cache: Optional :class:`~atlasent.cache.TTLCache` for caching
            evaluate results and avoiding redundant API calls.

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
        cache: TTLCache | None = None,
    ) -> None:
        self._api_key = _validate_api_key(api_key)
        self._anon_key = anon_key
        self._base_url = _enforce_tls(base_url).rstrip("/")
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

    # ── public API ──────────────────────────────────────

    def evaluate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
        *,
        resource_id: str | None = None,
        amount: float | None = None,
        approval: ApprovalReference | dict[str, Any] | None = None,
        require_approval: bool | None = None,
    ) -> EvaluateResult:
        """PLACEHOLDER"""
        raise NotImplementedError
