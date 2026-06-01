"""Asynchronous AtlaSent API client (httpx.AsyncClient-based)."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
import warnings
from collections.abc import AsyncIterator
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import TYPE_CHECKING, Any
from urllib.parse import quote, urlparse

import httpx

from ._version import __version__
from .access_governance_log import AccessGovernanceLogClient
from .approval_artifact import ApprovalReference
from .audit import AuditEventsResult, AuditExportResult
from .evidence_bundle import EvidenceBundlesClient
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
from .hitl import (
    HitlApprovalsResult,
    HitlChainResult,
    HitlCreateRequest,
    HitlEscalation,
    HitlEscalationResult,
    HitlStatus,
    ListHitlEscalationsResult,
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
    UserPermitsResult,
    VerifyResult,
)
from .policy_certification import PolicyCertificationClient
from .policy_sync import PolicySyncClient
from .scim import (
    ScimGroup,
    ScimListGroupsResponse,
    ScimListUsersResponse,
    ScimUser,
    _enc as _scim_enc,
)
from .siem import (
    _enc as _siem_enc,
)
from .trust_root import get_global_trust_root_manager

if TYPE_CHECKING:
    from .cache import TTLCache

_AUDIT_EXPORT_ACCEPT = "application/octet-stream"
_ACTION_TYPE_RE = __import__("re").compile(r"^[\w.-]+$")

DEFAULT_BASE_URL = "https://api.atlasent.io"
DEFAULT_TIMEOUT = 10
# Retry schedule parity with the TypeScript SDK:
#   4 total attempts (1 initial + 3 retries), delays 2 s -> 4 s -> 8 s
#   (capped at 16 s) via the exponential formula:
#   delay = min(16, retry_backoff * 2**attempt)
DEFAULT_MAX_RETRIES = 3
DEFAULT_RETRY_BACKOFF = 2.0


def _compute_execution_hash(payload: dict[str, Any]) -> str:
    """SHA-256 hex digest of the canonical JSON representation of *payload*.

    Used as the ``execution_hash`` field on verify calls (P1-5).
    """
    import hashlib

    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


class AsyncAtlaSentClient:
    """Async client for the AtlaSent API.

    Wraps ``httpx.AsyncClient`` for non-blocking I/O.
    Mirrors :class:`~atlasent.AtlaSentClient` method-for-method.
    """

    def __init__(
        self,
        *,
        api_key: str | None = None,
        anon_key: str | None = None,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_backoff: float = DEFAULT_RETRY_BACKOFF,
    ) -> None:
        from .auth import _resolve_keys

        self._api_key, self._anon_key = _resolve_keys(api_key, anon_key)
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            timeout=self._timeout,
        )

    # ── public API ─────────────────────────────────────────────────

    async def evaluate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> EvaluateResult:
        """Submit an evaluate request.

        Returns an :class:`~atlasent.models.EvaluateResult` on success.
        Raises :class:`~atlasent.exceptions.AtlaSentDenied` if the
        policy engine denies the action.
        """
        ctx = context or {}
        payload: dict[str, Any] = {
            "actor_id": actor_id,
            "action_type": action_type,
            "context": ctx,
        }
        resp = await self._post("/v1-evaluate", payload)
        body = resp.json()
        token = body.get("decision_id", "")
        if not body.get("permitted", False):
            reason = body.get("reason", "")
            raise AtlaSentDenied(
                body.get("decision", "deny"),
                permit_token=token,
                reason=reason,
                response_body=body,
            )
        return EvaluateResult(
            permit_token=token,
            audit_hash=body.get("audit_hash", ""),
            reason=body.get("reason", ""),
            expires_at=body.get("expires_at"),
        )

    async def evaluate_preflight(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> EvaluatePreflightResult:
        """Dry-run evaluate without side-effects.

        Returns a preflight result.  The permit is *not* consumed
        and cannot be used in a subsequent ``verify`` call.
        """
        ctx = context or {}
        payload: dict[str, Any] = {
            "actor_id": actor_id,
            "action_type": action_type,
            "context": ctx,
            "preflight": True,
        }
        resp = await self._post("/v1-evaluate", payload)
        body = resp.json()
        return EvaluatePreflightResult(
            permitted=body.get("permitted", False),
            decision_id=body.get("decision_id", ""),
            reason=body.get("reason", ""),
            audit_hash=body.get("audit_hash", ""),
            timestamp=body.get("timestamp", ""),
        )

    async def verify(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context: dict[str, Any] | None = None,
        *,
        environment: str | None = None,
        execution_hash: str | None = None,
    ) -> VerifyResult:
        """Verify a permit token server-side.

        .. deprecated::
            Use :meth:`protect` for the canonical end-to-end flow.
            Direct ``verify`` calls will be removed in v3.
        """
        import warnings

        warnings.warn(
            "AsyncAtlaSentClient.verify() is deprecated; use protect() for "
            "the end-to-end authorization primitive. "
            "Direct verify calls will be removed in atlasent v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        return await self._verify_internal(
            permit_token,
            action_type,
            actor_id,
            context,
            environment=environment,
            execution_hash=execution_hash,
        )

    async def _verify_internal(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context: dict[str, Any] | None = None,
        *,
        environment: str | None = None,
        execution_hash: str | None = None,
    ) -> VerifyResult:
        ctx = context or {}
        payload: dict[str, Any] = {
            "permit_token": permit_token,
            "actor_id": actor_id,
            "action_type": action_type,
        }
        if environment is not None:
            payload["environment"] = environment
        if execution_hash is not None:
            payload["execution_hash"] = execution_hash
        resp = await self._post("/v1-verify-permit", payload)
        body = resp.json()
        return VerifyResult(
            valid=body.get("verified", False),
            outcome=body.get("outcome", ""),
            permit_hash=body.get("permit_hash", ""),
            timestamp=body.get("timestamp", ""),
        )

    async def protect(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
    ) -> Permit:
        """Authorize an action end-to-end — the fail-closed execution primitive.

        Mirrors the TypeScript SDK's ``atlasent.protect()``. On allow, returns
        a verified :class:`Permit`. On policy denial, permit verification
        failure, or server unavailability raises :class:`AtlaSentDeniedError`.
        On transport / auth / rate-limit errors raises :class:`AtlaSentError`.

        ADR-005 D3: The trust snapshot expiry is checked before ``evaluate()``.
        When the snapshot is expired this raises :class:`BundleVerificationError`
        (a subclass of :class:`AtlaSentDeniedError`). Trust expiry is
        fail-closed: the action must not proceed.

        ``verify_unavailable``: if the verify step raises a 5xx
        :class:`AtlaSentError`, the action is denied with
        ``outcome="verify_unavailable"`` rather than propagating the raw server
        error — callers get a typed denial they can branch on.
        """
        if not _ACTION_TYPE_RE.match(action):
            raise AtlaSentError(
                (
                    "action must be in dot-notation format "
                    '(e.g. "production.deploy"). '
                    f"Got: {action!r}"
                ),
                code="bad_request",
            )
        # ADR-005 D3: fail-closed if trust snapshot has expired
        expiry = get_global_trust_root_manager().check_expiry()
        if expiry == "expired":
            snap = get_global_trust_root_manager().get_snapshot()
            raise BundleVerificationError(
                bundle_reason="trust_snapshot_expired",
                snapshot_valid_until=snap.valid_until,
                snapshot_fetched_at=snap.issued_at,
            )
        ctx = context or {}
        try:
            eval_result = await self.evaluate(action, agent, ctx)
        except AtlaSentDenied as exc:
            audit_hash = ""
            if exc.response_body is not None:
                candidate = exc.response_body.get("audit_hash")
                if isinstance(candidate, str):
                    audit_hash = candidate
            raise AtlaSentDeniedError(
                decision="deny",
                evaluation_id=exc.permit_token,
                reason=exc.reason,
                audit_hash=audit_hash,
            ) from None

        _ctx_env = (
            ctx.get("environment") if isinstance(ctx.get("environment"), str) else None
        )
        if not _ctx_env:
            raise AtlaSentError(
                "context.environment is required. Pass the environment where this "
                "action executes (for example, 'production' or 'staging').",
                code="bad_request",
            )

        _eval_payload: dict[str, Any] = {
            "action_type": action,
            "actor_id": agent,
            "context": ctx,
        }
        _execution_hash = _compute_execution_hash(_eval_payload)

        # Suppress the DeprecationWarning from the public verify() method:
        # protect() is the canonical API and should not surface deprecation
        # noise from its own internal implementation.
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
            permit_expires_at=eval_result.expires_at or None,
        )

    async def gate(
        self,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
    ) -> GateResult:
        """Evaluate then verify.  Returns a :class:`~atlasent.models.GateResult`.

        .. deprecated::
            Use :meth:`protect` for fail-closed execution.
            Will be removed in atlasent v3.
        """
        import warnings

        warnings.warn(
            "AsyncAtlaSentClient.gate() is deprecated; use protect() for fail-closed "
            "execution. Will be removed in atlasent v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        ctx = context or {}
        eval_result = await self.evaluate(action_type, actor_id, ctx)
        verify_result = await self._verify_internal(
            eval_result.permit_token, action_type, actor_id, ctx
        )
        return GateResult(
            permitted=True,
            decision_id=eval_result.permit_token,
            reason=eval_result.reason,
            audit_hash=eval_result.audit_hash,
            permit_hash=verify_result.permit_hash,
            timestamp=verify_result.timestamp,
        )

    async def authorize(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = None,
        verify: bool = True,
        raise_on_deny: bool = False,
    ) -> AuthorizationResult:
        """Evaluate (and optionally verify) an action.

        .. deprecated::
            Use :meth:`protect` for fail-closed execution
            (recommended — no ``permitted=False`` return path to forget),
            or :meth:`evaluate` to inspect the four-value decision.
            Will be removed in ``atlasent`` v3.

        Args:
            agent: Agent identifier.
            action: Action type string.
            context: Arbitrary policy context.
            verify: If ``True`` (default), verify the permit end-to-end.
            raise_on_deny: Raise :class:`PermissionDeniedError` on denial.

        Returns:
            :class:`~atlasent.models.AuthorizationResult`.
        """
        import warnings

        warnings.warn(
            "AsyncAtlaSentClient.authorize() is deprecated; use protect() "
            "for fail-closed execution. Will be removed in atlasent v3.",
            DeprecationWarning,
            stacklevel=2,
        )
        ctx = context or {}
        try:
            eval_result = await self.evaluate(action, agent, ctx)
        except AtlaSentDenied as exc:
            if raise_on_deny:
                from .exceptions import PermissionDeniedError

                raise PermissionDeniedError(
                    exc.decision,
                    permit_token=exc.permit_token,
                    reason=exc.reason,
                ) from exc
            return AuthorizationResult(
                permitted=False,
                decision_id=exc.permit_token,
                reason=exc.reason,
                audit_hash="",
                permit_hash="",
                verified=False,
                raw=exc.response_body or {},
            )

        if not verify:
            return AuthorizationResult(
                permitted=True,
                decision_id=eval_result.permit_token,
                reason=eval_result.reason,
                audit_hash=eval_result.audit_hash,
                permit_hash="",
                verified=False,
                raw=eval_result.model_dump(by_alias=True),
            )

        verify_result = await self._verify_internal(
            eval_result.permit_token, action, agent, ctx
        )
        return AuthorizationResult(
            permitted=True,
            decision_id=eval_result.permit_token,
            reason=eval_result.reason,
            audit_hash=eval_result.audit_hash,
            permit_hash=verify_result.permit_hash,
            verified=True,
            raw=eval_result.model_dump(by_alias=True),
        )

    # ── lifecycle ───────────────────────────────────────────────

    async def close(self) -> None:
        """Close the underlying HTTP client and release resources."""
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncAtlaSentClient":
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.close()

    # ── Permit lifecycle ───────────────────────────────────────────────────────

    async def get_permit(
        self,
        permit_id: str,
        *,
        include_evidence: bool = False,
    ) -> GetPermitResult:
        """``GET /v1/permits/{permitId}`` — fetch a permit's full lifecycle state."""
        params: dict[str, str] = {}
        if include_evidence:
            params["include_evidence"] = "true"
        resp = await self._get(f"/v1/permits/{quote(permit_id, safe='')}", params=params)
        body = resp.json()
        return GetPermitResult.model_validate(body)

    async def list_permits(
        self,
        *,
        actor_id: str | None = None,
        action_type: str | None = None,
        environment: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
    ) -> ListPermitsResult:
        """``GET /v1/permits`` — list permits with optional filters."""
        params: dict[str, str] = {}
        if actor_id is not None:
            params["actor_id"] = actor_id
        if action_type is not None:
            params["action_type"] = action_type
        if environment is not None:
            params["environment"] = environment
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get("/v1/permits", params=params)
        body = resp.json()
        return ListPermitsResult.model_validate(body)

    async def revoke_permit(self, permit_id: str) -> RevokePermitByIdResult:
        """``DELETE /v1/permits/{permitId}`` — hard-revoke a specific permit."""
        path = f"/v1/permits/{quote(permit_id, safe='')}"
        resp = await self._delete(path)
        body = resp.json()
        rate_limit = _extract_rate_limit(resp)
        result = RevokePermitByIdResult.model_validate(body)
        result.rate_limit = rate_limit
        return result

    # ── Canonical REST surface (parity with sync client) ────────────────────────

    async def get_permit(
        self, permit_id: str
    ) -> GetPermitResult:  # type: ignore[override]  # noqa: F811
        """Get a single permit's full lifecycle state

        ``GET /v1/permits/{permitId}``
        """
        resp = await self._get(f"/v1/permits/{quote(permit_id, safe='')}")
        body = resp.json()
        return GetPermitResult.model_validate(body)

    async def list_permits(
        self,
        *,
        actor_id: str | None = None,
        action_type: str | None = None,
        environment: str | None = None,
        status: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
    ) -> ListPermitsResult:  # type: ignore[override]  # noqa: F811
        """List permits with optional filters.

        ``GET /v1/permits``
        """
        params: dict[str, str] = {}
        if actor_id is not None:
            params["actor_id"] = actor_id
        if action_type is not None:
            params["action_type"] = action_type
        if environment is not None:
            params["environment"] = environment
        if status is not None:
            params["status"] = status
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get("/v1/permits", params=params)
        body = resp.json()
        return ListPermitsResult.model_validate(body)

    async def revoke_permit(
        self,
        permit_id: str,
        *,
        reason: str | None = None,
    ) -> RevokePermitResult:  # type: ignore[override]  # noqa: F811
        """Revoke a permit.

        ``DELETE /v1/permits/{permitId}``
        """
        path = f"/v1/permits/{quote(permit_id, safe='')}"
        body: dict[str, Any] = {}
        if reason is not None:
            body["reason"] = reason
        resp = await self._delete(path, body=body if body else None)
        body_resp = resp.json()
        rate_limit = _extract_rate_limit(resp)
        result = RevokePermitResult.model_validate(body_resp)
        result.rate_limit = rate_limit
        return result

    async def revoke_permit_by_actor(
        self,
        actor_id: str,
        action_type: str,
        *,
        reason: str | None = None,
    ) -> RevokePermitResult:
        """Revoke all active permits for an actor and action.

        ``POST /v1/permits/revoke``
        """
        payload: dict[str, Any] = {
            "actor_id": actor_id,
            "action_type": action_type,
        }
        if reason is not None:
            payload["reason"] = reason
        resp = await self._post("/v1/permits/revoke", payload)
        body = resp.json()
        rate_limit = _extract_rate_limit(resp)
        result = RevokePermitResult.model_validate(body)
        result.rate_limit = rate_limit
        return result

    async def get_api_key_self(self) -> ApiKeySelfResult:
        """``GET /v1/api-keys/self`` — introspect the current API key."""
        resp = await self._get("/v1/api-keys/self")
        body = resp.json()
        return ApiKeySelfResult.model_validate(body)

    async def list_user_permits(
        self,
        user_id: str,
        *,
        page: int | None = None,
        page_size: int | None = None,
    ) -> UserPermitsResult:
        """``GET /v1/users/{userId}/permits`` — list all active permits for a user."""
        params: dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get(
            f"/v1/users/{quote(user_id, safe='')}/permits", params=params
        )
        body = resp.json()
        return UserPermitsResult.model_validate(body)

    async def get_permit_evidence(
        self,
        permit_id: str,
    ) -> PermitVerifyEvidence:
        """``GET /v1/permits/{permitId}/evidence`` — retrieve verify evidence."""
        resp = await self._get(f"/v1/permits/{quote(permit_id, safe='')}/evidence")
        body = resp.json()
        return PermitVerifyEvidence.model_validate(body)

    async def list_constraint_traces(
        self,
        decision_id: str,
    ) -> list[ConstraintTrace]:
        """``GET /v1/decisions/{decisionId}/constraints`` — constraint traces."""
        resp = await self._get(
            f"/v1/decisions/{quote(decision_id, safe='')}/constraints"
        )
        body = resp.json()
        return [ConstraintTrace.model_validate(ct) for ct in body.get("traces", [])]

    # ── HITL (Human-in-the-Loop) ────────────────────────────────────────────────

    async def create_hitl_request(
        self,
        *,
        action_type: str,
        actor_id: str,
        context: dict[str, Any] | None = None,
        approver_ids: list[str] | None = None,
        timeout_seconds: int | None = None,
    ) -> HitlStatus:
        """``POST /v1/hitl/requests`` — create a human-in-the-loop approval request."""
        body: dict[str, Any] = {
            "action_type": action_type,
            "actor_id": actor_id,
            "context": context or {},
        }
        if approver_ids is not None:
            body["approver_ids"] = approver_ids
        if timeout_seconds is not None:
            body["timeout_seconds"] = timeout_seconds
        resp = await self._post("/v1/hitl/requests", body)
        return HitlStatus.model_validate(resp.json())

    async def approve_hitl_request(
        self, request_id: str, *, approver_id: str
    ) -> HitlStatus:
        """``POST /v1/hitl/requests/{id}/approve`` — approve a pending HITL request."""
        resp = await self._post(
            f"/v1/hitl/requests/{quote(request_id, safe='')}/approve",
            {"approver_id": approver_id},
        )
        return HitlStatus.model_validate(resp.json())

    async def reject_hitl_request(
        self, request_id: str, *, approver_id: str, reason: str = ""
    ) -> HitlStatus:
        """``POST /v1/hitl/requests/{id}/reject`` — reject a pending HITL request."""
        resp = await self._post(
            f"/v1/hitl/requests/{quote(request_id, safe='')}/reject",
            {"approver_id": approver_id, "reason": reason},
        )
        return HitlStatus.model_validate(resp.json())

    async def get_hitl_status(self, request_id: str) -> HitlStatus:
        """``GET /v1/hitl/requests/{id}`` — poll the status of a HITL request."""
        resp = await self._get(f"/v1/hitl/requests/{quote(request_id, safe='')}")
        return HitlStatus.model_validate(resp.json())

    async def list_hitl_escalations(
        self,
        *,
        actor_id: str | None = None,
        status: str | None = None,
        page: int | None = None,
        page_size: int | None = None,
    ) -> ListHitlEscalationsResult:
        """``GET /v1/hitl/escalations`` — list HITL escalation requests."""
        params: dict[str, str] = {}
        if actor_id is not None:
            params["actor_id"] = actor_id
        if status is not None:
            params["status"] = status
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get("/v1/hitl/escalations", params=params)
        return ListHitlEscalationsResult.model_validate(resp.json())

    async def create_hitl_chain(
        self,
        request: HitlCreateRequest,
    ) -> HitlChainResult:
        """``POST /v1/hitl/chains`` — create a multi-step HITL chain."""
        resp = await self._post("/v1/hitl/chains", request.model_dump(by_alias=True))
        return HitlChainResult.model_validate(resp.json())

    async def escalate_hitl(
        self,
        request_id: str,
        *,
        escalation: HitlEscalation,
    ) -> HitlEscalationResult:
        """``POST /v1/hitl/requests/{id}/escalate`` — escalate a HITL request."""
        resp = await self._post(
            f"/v1/hitl/requests/{quote(request_id, safe='')}/escalate",
            escalation.model_dump(by_alias=True),
        )
        return HitlEscalationResult.model_validate(resp.json())

    async def get_hitl_approvals(
        self,
        request_id: str,
    ) -> HitlApprovalsResult:
        """``GET /v1/hitl/requests/{id}/approvals`` — list approvals for a request."""
        resp = await self._get(
            f"/v1/hitl/requests/{quote(request_id, safe='')}/approvals"
        )
        return HitlApprovalsResult.model_validate(resp.json())

    # ── Governance agents ──────────────────────────────────────────────────────

    async def list_governance_agents(
        self,
        *,
        page: int | None = None,
        page_size: int | None = None,
    ) -> ListGovernanceAgentsResult:
        """``GET /v1/governance/agents`` — list registered governance agents."""
        params: dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get("/v1/governance/agents", params=params)
        return ListGovernanceAgentsResult.model_validate(resp.json())

    async def get_governance_agent(self, agent_id: str) -> GovernanceAgent:
        """``GET /v1/governance/agents/{agentId}`` — get a governance agent."""
        resp = await self._get(
            f"/v1/governance/agents/{quote(agent_id, safe='')}"
        )
        return GovernanceAgent.model_validate(resp.json())

    async def list_governance_evaluations(
        self,
        agent_id: str,
        *,
        page: int | None = None,
        page_size: int | None = None,
    ) -> ListGovernanceEvaluationsResult:
        """``GET /v1/governance/agents/{agentId}/evaluations``."""
        params: dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get(
            f"/v1/governance/agents/{quote(agent_id, safe='')}/evaluations",
            params=params,
        )
        return ListGovernanceEvaluationsResult.model_validate(resp.json())

    async def list_governance_findings(
        self,
        agent_id: str,
        *,
        page: int | None = None,
        page_size: int | None = None,
    ) -> ListGovernanceFindingsResult:
        """``GET /v1/governance/agents/{agentId}/findings``."""
        params: dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get(
            f"/v1/governance/agents/{quote(agent_id, safe='')}/findings",
            params=params,
        )
        return ListGovernanceFindingsResult.model_validate(resp.json())

    # ── Decision replay (ADR-015 §Replay, parity v2) ─────────────────────────────

    async def replay(self, *, evaluation_id: str) -> ReplayResponse:
        path = f"/v1/decisions/{quote(evaluation_id, safe='')}/replay"
        resp = await self._post(path, {})
        body = resp.json()
        rate_limit = _extract_rate_limit(resp)
        variances = [
            ReplayVarianceKind(
                field=v.get("field", ""),
                original=v.get("original"),
                replayed=v.get("replayed"),
            )
            for v in body.get("variances", [])
        ]
        result = ReplayResponse(
            evaluation_id=body.get("evaluation_id", ""),
            original_decision=body.get("original_decision", ""),
            replayed_decision=body.get("replayed_decision", ""),
            policy_version=body.get("policy_version", ""),
            variances=variances,
            variance_count=body.get("variance_count", 0),
            deterministic=body.get("deterministic", False),
            replayed_at=body.get("replayed_at", ""),
            rate_limit=rate_limit,
        )
        return result

    # ── SCIM 2.0 (async) ─────────────────────────────────────────────────────────────

    async def async_scim_list_users(
        self,
        org_id: str,
        *,
        filter: str | None = None,
        start_index: int = 1,
        count: int = 100,
    ) -> ScimListUsersResponse:
        """``GET /v1/scim/v2/{orgId}/Users`` — list SCIM users."""
        params: dict[str, str] = {
            "startIndex": str(start_index),
            "count": str(count),
        }
        if filter is not None:
            params["filter"] = filter
        resp = await self._get(
            f"/v1/scim/v2/{_scim_enc(org_id)}/Users", params=params
        )
        return ScimListUsersResponse.model_validate(resp.json())

    async def async_scim_get_user(self, org_id: str, user_id: str) -> ScimUser:
        """``GET /v1/scim/v2/{orgId}/Users/{userId}`` — get a SCIM user."""
        resp = await self._get(
            f"/v1/scim/v2/{_scim_enc(org_id)}/Users/{_scim_enc(user_id)}"
        )
        return ScimUser.model_validate(resp.json())

    async def async_scim_create_user(
        self, org_id: str, user_data: dict[str, Any]
    ) -> ScimUser:
        """``POST /v1/scim/v2/{orgId}/Users`` — provision a new SCIM user."""
        resp = await self._post(f"/v1/scim/v2/{_scim_enc(org_id)}/Users", user_data)
        return ScimUser.model_validate(resp.json())

    async def async_scim_update_user(
        self, org_id: str, user_id: str, user_data: dict[str, Any]
    ) -> ScimUser:
        """``PUT /v1/scim/v2/{orgId}/Users/{userId}`` — replace a SCIM user."""
        resp = await self._put(
            f"/v1/scim/v2/{_scim_enc(org_id)}/Users/{_scim_enc(user_id)}", user_data
        )
        return ScimUser.model_validate(resp.json())

    async def async_scim_delete_user(self, org_id: str, user_id: str) -> None:
        """``DELETE /v1/scim/v2/{orgId}/Users/{userId}`` — deprovision a SCIM user."""
        await self._delete(f"/v1/scim/v2/{_scim_enc(org_id)}/Users/{_scim_enc(user_id)}")

    async def async_scim_list_groups(
        self,
        org_id: str,
        *,
        filter: str | None = None,
        start_index: int = 1,
        count: int = 100,
    ) -> ScimListGroupsResponse:
        """``GET /v1/scim/v2/{orgId}/Groups`` — list SCIM groups."""
        params: dict[str, str] = {
            "startIndex": str(start_index),
            "count": str(count),
        }
        if filter is not None:
            params["filter"] = filter
        resp = await self._get(
            f"/v1/scim/v2/{_scim_enc(org_id)}/Groups", params=params
        )
        return ScimListGroupsResponse.model_validate(resp.json())

    async def async_scim_get_group(self, org_id: str, group_id: str) -> ScimGroup:
        """``GET /v1/scim/v2/{orgId}/Groups/{groupId}`` — get a SCIM group."""
        resp = await self._get(
            f"/v1/scim/v2/{_scim_enc(org_id)}/Groups/{_scim_enc(group_id)}"
        )
        return ScimGroup.model_validate(resp.json())

    async def async_scim_create_group(
        self, org_id: str, group_data: dict[str, Any]
    ) -> ScimGroup:
        """``POST /v1/scim/v2/{orgId}/Groups`` — create a new SCIM group."""
        resp = await self._post(f"/v1/scim/v2/{_scim_enc(org_id)}/Groups", group_data)
        return ScimGroup.model_validate(resp.json())

    async def async_scim_update_group(
        self, org_id: str, group_id: str, group_data: dict[str, Any]
    ) -> ScimGroup:
        """``PUT /v1/scim/v2/{orgId}/Groups/{groupId}`` — replace a SCIM group."""
        resp = await self._put(
            f"/v1/scim/v2/{_scim_enc(org_id)}/Groups/{_scim_enc(group_id)}",
            group_data,
        )
        return ScimGroup.model_validate(resp.json())

    async def async_scim_delete_group(
        self, org_id: str, group_id: str
    ) -> None:
        """``DELETE /v1/scim/v2/{orgId}/Groups/{groupId}`` — delete a SCIM group."""
        await self._delete(
            f"/v1/scim/v2/{_scim_enc(org_id)}/Groups/{_scim_enc(group_id)}"
        )

    # ── SIEM (async) ───────────────────────────────────────────────────

    async def async_get_siem_config(self, org_id: str) -> dict[str, Any]:
        """``GET /v1/orgs/{orgId}/siem-config`` — fetch current SIEM config (async)."""
        resp = await self._get(f"/v1/orgs/{_siem_enc(org_id)}/siem-config")
        return resp.json()

    async def async_update_siem_config(
        self, org_id: str, config: dict[str, Any]
    ) -> dict[str, Any]:
        """``PUT /v1/orgs/{orgId}/siem-config`` — update SIEM config (async)."""
        resp = await self._put(f"/v1/orgs/{_siem_enc(org_id)}/siem-config", config)
        return resp.json()

    async def async_delete_siem_config(self, org_id: str) -> None:
        """``DELETE /v1/orgs/{orgId}/siem-config`` — remove SIEM config (async)."""
        await self._delete(f"/v1/orgs/{_siem_enc(org_id)}/siem-config")

    async def async_list_siem_deliveries(
        self,
        org_id: str,
        *,
        page: int | None = None,
        page_size: int | None = None,
    ) -> dict[str, Any]:
        """``GET /v1/orgs/{orgId}/siem-exports`` — list SIEM delivery attempts (async)."""
        params: dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get(
            f"/v1/orgs/{_siem_enc(org_id)}/siem-exports", params=params
        )
        return resp.json()

    async def async_get_siem_delivery(
        self, org_id: str, delivery_id: str
    ) -> dict[str, Any]:
        """``GET /v1/orgs/{orgId}/siem-exports/{deliveryId}`` — delivery details (async)."""
        resp = await self._get(
            f"/v1/orgs/{_siem_enc(org_id)}/siem-exports/{_siem_enc(delivery_id)}"
        )
        return resp.json()

    async def async_retry_siem_delivery(
        self, org_id: str, delivery_id: str
    ) -> dict[str, Any]:
        """``POST /v1/orgs/{orgId}/siem-exports/{deliveryId}/retry`` — retry (async)."""
        resp = await self._post(
            f"/v1/orgs/{_siem_enc(org_id)}/siem-exports/{_siem_enc(delivery_id)}/retry",
            {},
        )
        return resp.json()

    async def async_siem_test_delivery(self, org_id: str) -> dict[str, Any]:
        """``POST /v1/orgs/{orgId}/siem-exports/test`` — send a test event (async)."""
        resp = await self._post(
            "POST", f"/v1/orgs/{_siem_enc(org_id)}/siem-exports/test", {}
        )
        return resp.json()

    # ── Evidence exports (async) ──────────────────────────────────────────────────

    async def async_list_evidence_exports(
        self,
        org_id: str,
        *,
        page: int | None = None,
        page_size: int | None = None,
    ) -> dict[str, Any]:
        """``GET /v1/orgs/{orgId}/evidence-exports`` — list evidence exports (async)."""
        params: dict[str, str] = {}
        if page is not None:
            params["page"] = str(page)
        if page_size is not None:
            params["page_size"] = str(page_size)
        resp = await self._get(
            f"/v1/orgs/{_ev_enc(org_id)}/evidence-exports", params=params
        )
        return resp.json()

    async def async_get_evidence_export(
        self, org_id: str, export_id: str
    ) -> dict[str, Any]:
        """``GET /v1/orgs/{orgId}/evidence-exports/{exportId}`` — fetch export (async)."""
        resp = await self._get(
            f"/v1/orgs/{_ev_enc(org_id)}/evidence-exports/{_ev_enc(export_id)}"
        )
        return resp.json()

    async def async_create_evidence_export(
        self, org_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        """``POST /v1/orgs/{orgId}/evidence-exports`` — create evidence export (async)."""
        resp = await self._post(
            f"/v1/orgs/{_ev_enc(org_id)}/evidence-exports", body
        )
        return resp.json()

    # ── internals ──────────────────────────────────────────────

    async def _post(
        self,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """POST with retry, auth header injection, and structured error handling."""
        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                delay = min(16, self._retry_backoff * 2 ** (attempt - 1))
                await asyncio.sleep(delay)
            try:
                resp = await self._client.post(
                    path,
                    json=body or {},
                    headers=self._build_headers(),
                )
            except httpx.TimeoutException as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    continue
                raise AtlaSentError(
                    "Request timed out",
                    code="timeout",
                ) from exc
            except httpx.NetworkError as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    continue
                raise AtlaSentError(
                    "Network error",
                    code="network",
                ) from exc
            error = _handle_error_response(resp)
            if error is not None:
                if error.status_code is not None and error.status_code >= 500:
                    last_exc = error
                    if attempt < self._max_retries:
                        continue
                raise error
            return resp
        raise AtlaSentError(
            "Max retries exceeded",
            code="network",
        ) from last_exc

    async def _get(
        self,
        path: str,
        *,
        params: dict[str, str] | None = None,
    ) -> httpx.Response:
        """GET with retry, auth header injection, and structured error handling."""
        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            if attempt > 0:
                delay = min(16, self._retry_backoff * 2 ** (attempt - 1))
                await asyncio.sleep(delay)
            try:
                resp = await self._client.get(
                    path,
                    params=params or {},
                    headers=self._build_headers(),
                )
            except httpx.TimeoutException as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    continue
                raise AtlaSentError(
                    "Request timed out",
                    code="timeout",
                ) from exc
            except httpx.NetworkError as exc:
                last_exc = exc
                if attempt < self._max_retries:
                    continue
                raise AtlaSentError(
                    "Network error",
                    code="network",
                ) from exc
            error = _handle_error_response(resp)
            if error is not None:
                if error.status_code is not None and error.status_code >= 500:
                    last_exc = error
                    if attempt < self._max_retries:
                        continue
                raise error
            return resp
        raise AtlaSentError(
            "Max retries exceeded",
            code="network",
        ) from last_exc

    async def _put(
        self,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """PUT with auth header injection and structured error handling."""
        resp = await self._client.put(
            path,
            json=body or {},
            headers=self._build_headers(),
        )
        error = _handle_error_response(resp)
        if error is not None:
            raise error
        return resp

    async def _delete(
        self,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """DELETE with auth header injection and structured error handling."""
        kwargs: dict[str, Any] = {"headers": self._build_headers()}
        if body:
            kwargs["json"] = body
        resp = await self._client.delete(path, **kwargs)
        error = _handle_error_response(resp)
        if error is not None:
            raise error
        return resp

    async def _do_scim(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """SCIM request helper — sets the SCIM content-type header."""
        headers = self._build_headers()
        headers["Content-Type"] = "application/scim+json"
        try:
            if method == "GET":
                resp = await self._client.get(path, headers=headers)
            elif method == "POST":
                resp = await self._client.post(path, json=body or {}, headers=headers)
            elif method == "PUT":
                resp = await self._client.put(path, json=body or {}, headers=headers)
            elif method == "DELETE":
                resp = await self._client.delete(path, headers=headers)
            elif method == "PATCH":
                resp = await self._client.patch(path, json=body or {}, headers=headers)
            else:
                raise ValueError(f"Unsupported method: {method}")
        except httpx.TimeoutException as exc:
            raise AtlaSentError(
                "Request timed out",
                code="timeout",
            ) from exc
        except httpx.NetworkError as exc:
            raise AtlaSentError(
                "Network error",
                code="network",
            ) from exc
        error = _handle_error_response(resp)
        if error is not None:
            raise error
        return resp

    def _build_headers(self) -> dict[str, str]:
        headers: dict[str, str] = {
            "X-AtlaSent-SDK-Version": f"atlasent-python/{__version__}",
            "X-Request-ID": str(uuid.uuid4()),
        }
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        if self._anon_key:
            headers["X-AtlaSent-Anon-Key"] = self._anon_key
        return headers

    async def _stream_post(
        self,
        path: str,
        body: dict[str, Any],
        *,
        stream_timeout: float = 120.0,
    ) -> AsyncIterator[dict[str, Any]]:
        """POST that yields parsed SSE events (``data:`` lines) as dicts."""
        headers = self._build_headers()
        headers["Accept"] = "text/event-stream"
        headers["Cache-Control"] = "no-cache"
        async with self._client.stream(
            "POST",
            path,
            json=body,
            headers=headers,
            timeout=httpx.Timeout(connect=10.0, read=stream_timeout, write=10.0, pool=10.0),
        ) as resp:
            error = _handle_error_response(resp)
            if error is not None:
                raise error
            async for event in _parse_sse(resp.aiter_lines()):
                yield event

    async def _access_governance_log(
        self,
    ) -> AccessGovernanceLogClient:
        return AccessGovernanceLogClient(self)

    async def _policy_certification(
        self,
    ) -> PolicyCertificationClient:
        return PolicyCertificationClient(self)

    async def _evidence_bundle(
        self,
    ) -> EvidenceBundlesClient:
        return EvidenceBundlesClient(self)

    async def _policy_sync(
        self,
    ) -> PolicySyncClient:
        return PolicySyncClient(self)

    async def _do_stream_scim(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """SCIM helper for streaming (unused but mirrored from sync)."""
        return await self._do_scim(method, path, body)

    async def _do_ev(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Evidence exports request helper."""
        headers = self._build_headers()
        try:
            if method == "GET":
                resp = await self._client.get(path, headers=headers)
            elif method == "POST":
                resp = await self._client.post(path, json=body or {}, headers=headers)
            elif method == "DELETE":
                resp = await self._client.delete(path, headers=headers)
            else:
                raise ValueError(f"Unsupported method: {method}")
        except httpx.TimeoutException as exc:
            raise AtlaSentError(
                "Request timed out",
                code="timeout",
            ) from exc
        except httpx.NetworkError as exc:
            raise AtlaSentError(
                "Network error",
                code="network",
            ) from exc
        error = _handle_error_response(resp)
        if error is not None:
            raise error
        return resp

    async def _do_siem(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """SIEM request helper."""
        headers = self._build_headers()
        try:
            if method == "GET":
                resp = await self._client.get(path, headers=headers)
            elif method == "POST":
                resp = await self._client.post(path, json=body or {}, headers=headers)
            elif method == "PUT":
                resp = await self._client.put(path, json=body or {}, headers=headers)
            elif method == "DELETE":
                resp = await self._client.delete(path, headers=headers)
            else:
                raise ValueError(f"Unsupported method: {method}")
        except httpx.TimeoutException as exc:
            raise AtlaSentError(
                "Request timed out",
                code="timeout",
            ) from exc
        except httpx.NetworkError as exc:
            raise AtlaSentError(
                "Network error",
                code="network",
            ) from exc
        error = _handle_error_response(resp)
        if error is not None:
            raise error
        return resp

    async def _do_hitl(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """HITL request helper."""
        headers = self._build_headers()
        try:
            if method == "GET":
                resp = await self._client.get(path, headers=headers)
            elif method == "POST":
                resp = await self._client.post(path, json=body or {}, headers=headers)
            elif method == "PUT":
                resp = await self._client.put(path, json=body or {}, headers=headers)
            elif method == "DELETE":
                resp = await self._client.delete(path, headers=headers)
            else:
                raise ValueError(f"Unsupported method: {method}")
        except httpx.TimeoutException as exc:
            raise AtlaSentError(
                "Request timed out",
                code="timeout",
            ) from exc
        except httpx.NetworkError as exc:
            raise AtlaSentError(
                "Network error",
                code="network",
            ) from exc
        error = _handle_error_response(resp)
        if error is not None:
            raise error
        return resp

    async def _do_governance(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Governance request helper."""
        headers = self._build_headers()
        try:
            if method == "GET":
                resp = await self._client.get(path, headers=headers)
            elif method == "POST":
                resp = await self._client.post(path, json=body or {}, headers=headers)
            elif method == "PUT":
                resp = await self._client.put(path, json=body or {}, headers=headers)
            elif method == "DELETE":
                resp = await self._client.delete(path, headers=headers)
            else:
                raise ValueError(f"Unsupported method: {method}")
        except httpx.TimeoutException as exc:
            raise AtlaSentError(
                "Request timed out",
                code="timeout",
            ) from exc
        except httpx.NetworkError as exc:
            raise AtlaSentError(
                "Network error",
                code="network",
            ) from exc
        error = _handle_error_response(resp)
        if error is not None:
            raise error
        return resp

    async def _do_replay(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> httpx.Response:
        """Replay request helper."""
        headers = self._build_headers()
        try:
            if method == "GET":
                resp = await self._client.get(path, headers=headers)
            elif method == "POST":
                resp = await self._client.post(path, json=body or {}, headers=headers)
            else:
                raise ValueError(f"Unsupported method: {method}")
        except httpx.TimeoutException as exc:
            raise AtlaSentError(
                "Request timed out",
                code="timeout",
            ) from exc
        except httpx.NetworkError as exc:
            raise AtlaSentError(
                "Network error",
                code="network",
            ) from exc
        error = _handle_error_response(resp)
        if error is not None:
            raise error
        return resp


def _handle_error_response(resp: httpx.Response) -> AtlaSentError | None:
    if resp.status_code == 200:
        return None
    if resp.status_code == 401:
        return AtlaSentError(
            "Invalid API key",
            status_code=401,
            code="invalid_api_key",
        )
    if resp.status_code == 403:
        return AtlaSentError(
            "Forbidden",
            status_code=403,
            code="forbidden",
        )
    if resp.status_code == 429:
        headers = resp.headers if hasattr(resp, "headers") else {}
        retry_after: float | None = None
        raw_ra = headers.get("retry-after")
        if raw_ra is not None:
            try:
                retry_after = float(raw_ra)
            except ValueError:
                try:
                    dt = parsedate_to_datetime(raw_ra)
                    retry_after = max(0.0, (dt - datetime.now(timezone.utc)).total_seconds())
                except Exception:
                    pass
        return RateLimitError(retry_after=retry_after)
    if resp.status_code == 400:
        try:
            body = resp.json()
        except Exception:
            body = {}
        msg = body.get("message") or body.get("error") or resp.text or "Bad request"
        return AtlaSentError(
            msg,
            status_code=400,
            code="bad_request",
            response_body=body,
        )
    if resp.status_code >= 500:
        try:
            text = resp.text
        except Exception:
            text = ""
        return AtlaSentError(
            f"Server error {resp.status_code}: {text[:200]}",
            status_code=resp.status_code,
            code="server_error",
        )
    return None


def _extract_rate_limit(resp: httpx.Response) -> RateLimitState | None:
    headers = resp.headers if hasattr(resp, "headers") else {}
    limit = headers.get("x-ratelimit-limit")
    remaining = headers.get("x-ratelimit-remaining")
    reset_at = headers.get("x-ratelimit-reset")
    if any(v is not None for v in [limit, remaining, reset_at]):
        return RateLimitState(
            limit=int(limit) if limit else None,
            remaining=int(remaining) if remaining else None,
            reset_at=reset_at,
        )
    return None


# ── SSE parser ────────────────────────────────────────────────────────────────────────


async def _parse_sse(
    lines: AsyncIterator[str],
    *,
    timeout_s: float = 120.0,
) -> AsyncIterator[dict[str, Any]]:
    """Parse Server-Sent Events from an async line iterator.

    Yields each complete ``data:`` payload as a parsed JSON dict.
    Raises :class:`~atlasent.exceptions.StreamTimeoutError` if
    ``timeout_s`` seconds pass without a complete event.
    Raises :class:`~atlasent.exceptions.StreamParseError` on
    malformed JSON payloads.
    """
    event_data: list[str] = []
    event_id: str | None = None
    last_event_at = asyncio.get_event_loop().time()

    async def _next_with_timeout() -> str | None:
        try:
            return await asyncio.wait_for(
                lines.__anext__(),
                timeout=timeout_s,
            )
        except asyncio.TimeoutError:
            raise StreamTimeoutError(timeout_s)
        except StopAsyncIteration:
            return None

    while True:
        line = await _next_with_timeout()
        if line is None:
            break
        line = line.rstrip("\r")
        if not line:
            if event_data:
                raw = "\n".join(event_data)
                try:
                    yield json.loads(raw)
                except json.JSONDecodeError as exc:
                    raise StreamParseError(raw, cause=exc)
                event_data = []
                event_id = None
                last_event_at = asyncio.get_event_loop().time()
        elif line.startswith("data:"):
            event_data.append(line[5:].lstrip(" "))
        elif line.startswith("data") and ":" not in line:
            event_data.append("")
        elif line.startswith("id: ") or line.startswith("id:"):
            event_id = line.split(":", 1)[1].strip()
