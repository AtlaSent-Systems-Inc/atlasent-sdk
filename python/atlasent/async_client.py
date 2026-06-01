"""Asynchronous AtlaSent API client (httpx.AsyncClient-based)."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
import warnings
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any
from urllib.parse import quote

import httpx

from ._version import __version__
from .approval_artifact import ApprovalReference
from .audit import AuditEventsResult, AuditExportResult
from .client import (
    _ACTION_TYPE_RE,
    _compute_execution_hash,
    _enforce_tls,
    _parse_rate_limit_headers,
    _parse_retry_after,
    _redact_token,
    _server_message,
    _validate_api_key,
)
from .evidence_exports import (
    _VALID_REGIMES,
)
from .evidence_exports import (
    _enc as _ev_enc,
)
from .exceptions import (
    AtlaSentDenied,
    AtlaSentDeniedError,
    AtlaSentError,
    BundleVerificationError,
    PermissionDeniedError,
    RateLimitError,
    StreamParseError,
    StreamTimeoutError,
    _normalize_permit_outcome,
)
from .governance_agents import (
    GovernanceAgent,
    GovernanceAgentEvaluation,
    GovernanceAgentFinding,
    ListGovernanceAgentsResult,
    ListGovernanceEvaluationsResult,
    ListGovernanceFindingsResult,
)
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
    ReplayResponse,
    ReplayVarianceKind,
    RevokePermitByIdResult,
    RevokePermitResult,
    Scope,
    SubjectTagSet,
    TagSetResult,
    VerifyPermitResult,
)
from .policy import PolicyResult
from .roles import RoleAssignmentsResult, RolesResult
from .scim import (
    ScimGroup,
    ScimGroupListResponse,
    ScimGroupMember,
    ScimUser,
    ScimUserListResponse,
)
from .trust_root import get_global_trust_root_manager
from .webhooks import WebhookResult, WebhooksResult

if TYPE_CHECKING:
    from .models import ActionContext

log = logging.getLogger(__name__)


class AsyncAtlaSentClient:
    """Async client for the AtlaSent API.

    Parameters
    ----------
    api_key:
        Your AtlaSent API key (``sk-…``).  Reads ``ATLASENT_API_KEY`` from
        the environment when omitted.
    base_url:
        Override the default ``https://api.atlasent.io`` endpoint.
    timeout:
        Request timeout in seconds (default 30).
    verify_ssl:
        Set to ``False`` to disable TLS verification (not recommended).
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = "https://api.atlasent.io",
        timeout: float = 30.0,
        verify_ssl: bool = True,
        _http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = _validate_api_key(api_key)
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        if _http_client is not None:
            self._client = _http_client
        else:
            _enforce_tls(base_url, verify_ssl)
            self._client = httpx.AsyncClient(
                base_url=self._base_url,
                timeout=timeout,
                verify=verify_ssl,
            )

    # ── lifecycle ──────────────────────────────────────────────────

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncAtlaSentClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    # ── internal helpers ───────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
        stream: bool = False,
    ) -> httpx.Response:
        hdrs = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "User-Agent": f"atlasent-python/{__version__}",
        }
        if headers:
            hdrs.update(headers)
        request = self._client.build_request(
            method,
            path,
            json=json,
            params=params,
            headers=hdrs,
        )
        if stream:
            return await self._client.send(request, stream=True)
        response = await self._client.send(request)
        return response

    async def _json(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        resp = await self._request(method, path, json=body, params=params)
        if resp.status_code >= 400:
            _body: dict[str, Any] = {}
            try:
                _body = resp.json()
            except Exception:
                pass
            raise AtlaSentError.from_response(resp.status_code, _body)
        return resp.json()

    # ── evaluate ───────────────────────────────────────────────────

    async def evaluate(
        self,
        action: str,
        agent: str | ActionContext,
        ctx: dict[str, Any] | None = None,
        *,
        environment: str | None = None,
    ) -> EvaluateResult:
        """Evaluate an action for an agent and return the decision.

        Parameters
        ----------
        action:
            The action identifier (e.g. ``"documents:read"``).
        agent:
            Either an ``ActionContext`` object or a plain string agent-id.
        ctx:
            Optional key/value context forwarded to policy rules.
        environment:
            Optional environment slug (e.g. ``"production"``).
        """
        if not _ACTION_TYPE_RE.fullmatch(action):
            raise ValueError(
                f"Invalid action identifier {action!r}: "
                "must match '<resource>:<verb>' with alphanumeric/hyphen/underscore."
            )
        from .models import ActionContext, BuildActionContextInput, buildActionContext

        if isinstance(agent, str):
            agent = buildActionContext(BuildActionContextInput(agent_id=agent))

        request_body = EvaluateRequest(
            action=action,
            agent=agent,
            ctx=ctx or {},
            environment=environment,
        )
        data = await self._json("POST", "/v1/evaluate", body=request_body.model_dump(exclude_none=True))
        return EvaluateResult(**data)

    # ── verify ──────────────────────────────────────────────────────

    async def verify(
        self,
        permit_token: str,
        action: str,
        agent: str | ActionContext,
        ctx: dict[str, Any] | None = None,
        *,
        environment: str | None = None,
        execution_hash: str | None = None,
    ) -> VerifyPermitResult:
        """Verify a permit token and return the verification result.

        Parameters
        ----------
        permit_token:
            The permit token returned by ``evaluate()``.
        action:
            The action that was authorised.
        agent:
            Either an ``ActionContext`` or plain string agent-id.
        ctx:
            Optional key/value context.
        environment:
            Optional environment slug.
        execution_hash:
            Optional execution hash for audit linking.
        """
        from .models import ActionContext, BuildActionContextInput, buildActionContext

        if isinstance(agent, str):
            agent = buildActionContext(BuildActionContextInput(agent_id=agent))

        body: dict[str, Any] = {
            "permit_token": permit_token,
            "action": action,
            "agent": agent.model_dump(exclude_none=True),
            "ctx": ctx or {},
        }
        if environment is not None:
            body["environment"] = environment
        if execution_hash is not None:
            body["execution_hash"] = execution_hash

        data = await self._json("POST", "/v1/verify", body=body)
        return VerifyPermitResult(**data)

    # ── protect ────────────────────────────────────────────────────

    async def protect(
        self,
        action: str,
        agent: str | ActionContext,
        ctx: dict[str, Any] | None = None,
        *,
        environment: str | None = None,
    ) -> Permit:
        """Evaluate *and* verify in one call; raise on deny (fail-closed).

        This is the primary execution-time authorization boundary. It:

        1. Checks that the local trust-root snapshot is not expired
           (ADR-005 D3 — fail-closed).
        2. Calls ``evaluate()`` to obtain a permit token.
        3. Calls ``verify()`` to confirm the permit is valid on the server.
        4. Returns a :class:`Permit` on success.

        On **any** deny or error the method raises rather than returning,
        so callers can treat the return value as a proof of authorization.

        ``verify_unavailable``: if the verify step raises a 5xx
        ``AtlaSentError``, or an error with code ``server_error``,
        ``timeout``, or ``network``, ``protect()`` surfaces
        ``outcome="verify_unavailable"`` rather than propagating the raw server
        error.  This gives callers a typed branch without having to inspect
        HTTP status codes.

        Parameters
        ----------
        action:
            The action identifier (e.g. ``"documents:read"``).
        agent:
            Either an ``ActionContext`` object or a plain string agent-id.
        ctx:
            Optional key/value context forwarded to policy rules.
        environment:
            Optional environment slug (e.g. ``"production"``).

        Raises
        ------
        BundleVerificationError
            If the local trust-root snapshot has expired.
        AtlaSentDeniedError
            If ``evaluate()`` returns ``"deny"`` or ``verify()`` returns
            ``valid=False``.
        AtlaSentError
            For unexpected API errors.
        """
        # ADR-005 D3: fail-closed if the trust snapshot has expired.
        expiry = get_global_trust_root_manager().check_expiry()
        if expiry == "expired":
            snap = get_global_trust_root_manager().get_snapshot()
            raise BundleVerificationError(
                bundle_reason="trust_snapshot_expired",
                snapshot_valid_until=snap.valid_until,
                snapshot_fetched_at=snap.issued_at,
            )

        from .models import ActionContext, BuildActionContextInput, buildActionContext

        if isinstance(agent, str):
            agent = buildActionContext(BuildActionContextInput(agent_id=agent))

        _ctx_env = environment
        _execution_hash = _compute_execution_hash(action, agent, ctx)

        eval_result = await self.evaluate(
            action,
            agent,
            ctx,
            environment=_ctx_env,
        )

        if eval_result.decision == "deny":
            raise AtlaSentDeniedError(
                decision="deny",
                evaluation_id=eval_result.permit_token,
                reason=eval_result.reason,
                audit_hash=eval_result.audit_hash,
                outcome=_normalize_permit_outcome(eval_result.outcome),
            )

        # verify_unavailable: if the verify step returns 5xx, surface a typed
        # AtlaSentDeniedError(outcome="verify_unavailable") rather than a raw
        # AtlaSentError, so callers can branch without inspecting HTTP codes.
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                verify_result = await self.verify(
                    eval_result.permit_token,
                    action,
                    agent,
                    ctx,
                    environment=_ctx_env,
                    execution_hash=_execution_hash,
                )
        except AtlaSentError as verify_err:
            if (
                verify_err.status_code is not None and verify_err.status_code >= 500
            ) or verify_err.code in ("server_error", "timeout", "network"):
                raise AtlaSentDeniedError(
                    decision="deny",
                    evaluation_id=eval_result.permit_token,
                    reason=f"Permit verification unavailable: {verify_err.message}",
                    audit_hash=eval_result.audit_hash,
                    outcome="verify_unavailable",
                ) from verify_err
            raise

        if not verify_result.valid:
            raise AtlaSentDeniedError(
                decision="deny",
                evaluation_id=eval_result.permit_token,
                reason=f"Permit failed verification ({verify_result.outcome})",
                audit_hash=eval_result.audit_hash,
                outcome=_normalize_permit_outcome(verify_result.outcome),
            )

        return Permit(
            permit_id=eval_result.permit_token,
            permit_hash=verify_result.permit_hash,
            audit_hash=eval_result.audit_hash,
            reason=eval_result.reason,
            timestamp=verify_result.timestamp,
        )