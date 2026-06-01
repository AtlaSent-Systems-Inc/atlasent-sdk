"""Asynchronous AtlaSent API client (httpx.AsyncClient-based)."""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
import warnings
from collections.abc import AsyncIterator
from typing import Any, overload

import httpx

from .errors import AtlaSentError, AuthenticationError, RateLimitError
from .models import (
    DecisionRequest,
    DecisionResponse,
    StreamDecisionEvent,
    StreamProgressEvent,
)
from .retry import DEFAULT_RETRY_CONFIG, RetryConfig, should_retry
from .version import VERSION

__all__ = ["AsyncAtlaSentClient"]

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.atlasent.io/v1"
_DEFAULT_TIMEOUT = 30.0
_DEFAULT_CONNECT_TIMEOUT = 10.0


class AsyncAtlaSentClient:
    """Async client for the AtlaSent Decision API.

    Parameters
    ----------
    api_key:
        Your AtlaSent API key.  Falls back to the ``ATLASENT_API_KEY``
        environment variable when *None*.
    base_url:
        Override the API base URL (useful for staging / local dev).
    timeout:
        Default read-timeout in seconds for every request.
    connect_timeout:
        TCP-connect timeout in seconds.
    max_retries:
        Maximum number of automatic retries on transient errors.
    retry_config:
        Fine-grained retry configuration; takes precedence over
        *max_retries* when supplied.
    http_client:
        Bring-your-own :class:`httpx.AsyncClient`.  The caller is
        responsible for closing it.
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str = _BASE_URL,
        timeout: float = _DEFAULT_TIMEOUT,
        connect_timeout: float = _DEFAULT_CONNECT_TIMEOUT,
        max_retries: int = 3,
        retry_config: RetryConfig | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        import os

        resolved_key = api_key or os.environ.get("ATLASENT_API_KEY", "")
        if not resolved_key:
            raise AuthenticationError(
                "No API key provided. Pass api_key= or set ATLASENT_API_KEY."
            )

        self._api_key = resolved_key
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout
        self._connect_timeout = connect_timeout
        self._retry_config = retry_config or DEFAULT_RETRY_CONFIG._replace(
            max_retries=max_retries
        )
        self._own_client = http_client is None
        self._client = http_client or httpx.AsyncClient(
            timeout=httpx.Timeout(timeout, connect=connect_timeout),
            headers=self._base_headers(),
        )

    # ── context-manager support ───────────────────────────────────────────────

    async def __aenter__(self) -> "AsyncAtlaSentClient":
        return self

    async def __aexit__(self, *_: Any) -> None:
        await self.close()

    async def close(self) -> None:
        """Close the underlying HTTP client (no-op for bring-your-own clients)."""
        if self._own_client:
            await self._client.aclose()

    # ── public API ────────────────────────────────────────────────────────────

    async def decide(
        self,
        request: DecisionRequest | dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> DecisionResponse:
        """Submit a decision request and return the full response.

        Parameters
        ----------
        request:
            A :class:`DecisionRequest` instance *or* a plain ``dict``
            that will be coerced into one.
        timeout:
            Per-request timeout override (seconds).
        idempotency_key:
            Optional idempotency key forwarded as
            ``Idempotency-Key: <value>`` header.

        Returns
        -------
        DecisionResponse
        """
        if isinstance(request, dict):
            request = DecisionRequest(**request)

        body = request.model_dump(mode="json", exclude_none=True)
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        raw = await self._request(
            "POST",
            "/decisions",
            json=body,
            timeout=timeout,
            extra_headers=extra_headers,
        )
        return DecisionResponse.model_validate(raw)

    @overload
    async def stream(
        self,
        request: DecisionRequest | dict[str, Any],
        *,
        timeout: float | None = ...,
        idempotency_key: str | None = ...,
    ) -> AsyncIterator[StreamDecisionEvent | StreamProgressEvent]: ...

    async def stream(  # type: ignore[misc]
        self,
        request: DecisionRequest | dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> AsyncIterator[StreamDecisionEvent | StreamProgressEvent]:
        """Submit a decision request and stream events as they arrive.

        Yields
        ------
        StreamDecisionEvent | StreamProgressEvent
            One object per SSE event emitted by the server.

        Example
        -------
        ::

            async for event in client.stream(req):
                print(event)
        """
        if isinstance(request, dict):
            request = DecisionRequest(**request)

        body = request.model_dump(mode="json", exclude_none=True)
        body["stream"] = True

        extra_headers: dict[str, str] = {"Accept": "text/event-stream"}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        effective_timeout = timeout if timeout is not None else self._timeout
        request_id = str(uuid.uuid4())

        async with self._client.stream(
            "POST",
            f"{self._base_url}/decisions",
            json=body,
            headers={**self._base_headers(), **extra_headers},
            timeout=httpx.Timeout(effective_timeout, connect=self._connect_timeout),
        ) as response:
            _raise_for_status(response, request_id=request_id)
            async for event in _parse_sse(
                _iter_lines(response),
                request_id=request_id,
                timeout_s=effective_timeout,
            ):
                yield event

    async def list_decisions(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        before: str | None = None,
        status: str | None = None,
        timeout: float | None = None,
    ) -> list[DecisionResponse]:
        """Retrieve a paginated list of past decisions.

        Parameters
        ----------
        limit:
            Maximum number of results (1-100, default 20).
        after:
            Return decisions created after this cursor (ISO-8601 or ID).
        before:
            Return decisions created before this cursor.
        status:
            Filter by decision status (e.g. ``"approved"``,
            ``"rejected"``, ``"pending"``).
        timeout:
            Per-request timeout override.
        """
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after
        if before:
            params["before"] = before
        if status:
            params["status"] = status

        raw = await self._request(
            "GET", "/decisions", params=params, timeout=timeout
        )
        return [DecisionResponse.model_validate(item) for item in raw.get("data", [])]

    async def get_decision(
        self,
        decision_id: str,
        *,
        timeout: float | None = None,
    ) -> DecisionResponse:
        """Fetch a single decision by ID."""
        raw = await self._request(
            "GET", f"/decisions/{decision_id}", timeout=timeout
        )
        return DecisionResponse.model_validate(raw)

    async def cancel_decision(
        self,
        decision_id: str,
        *,
        reason: str | None = None,
        timeout: float | None = None,
    ) -> DecisionResponse:
        """Cancel a pending decision.

        Parameters
        ----------
        decision_id:
            The ID of the decision to cancel.
        reason:
            Optional human-readable cancellation reason stored on the
            decision record.
        timeout:
            Per-request timeout override.
        """
        body: dict[str, Any] = {}
        if reason:
            body["reason"] = reason

        raw = await self._request(
            "POST",
            f"/decisions/{decision_id}/cancel",
            json=body or None,
            timeout=timeout,
        )
        return DecisionResponse.model_validate(raw)

    async def get_rule(
        self,
        rule_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch a decision rule by ID."""
        return await self._request("GET", f"/rules/{rule_id}", timeout=timeout)

    async def list_rules(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        enabled: bool | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List decision rules.

        Parameters
        ----------
        limit:
            Maximum number of results (1-100, default 20).
        after:
            Pagination cursor.
        enabled:
            When *True* / *False*, filter to enabled / disabled rules.
        timeout:
            Per-request timeout override.
        """
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after
        if enabled is not None:
            params["enabled"] = str(enabled).lower()

        raw = await self._request(
            "GET", "/rules", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def create_rule(
        self,
        rule: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a new decision rule.

        Parameters
        ----------
        rule:
            Rule definition payload (see API docs for schema).
        timeout:
            Per-request timeout override.
        idempotency_key:
            Optional idempotency key.
        """
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/rules",
            json=rule,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def update_rule(
        self,
        rule_id: str,
        updates: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Partially update an existing rule (HTTP PATCH)."""
        return await self._request(
            "PATCH", f"/rules/{rule_id}", json=updates, timeout=timeout
        )

    async def delete_rule(
        self,
        rule_id: str,
        *,
        timeout: float | None = None,
    ) -> None:
        """Delete a rule (no return value on success)."""
        await self._request("DELETE", f"/rules/{rule_id}", timeout=timeout)

    async def get_policy(
        self,
        policy_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch a policy by ID."""
        return await self._request(
            "GET", f"/policies/{policy_id}", timeout=timeout
        )

    async def list_policies(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List all policies."""
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after

        raw = await self._request(
            "GET", "/policies", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def create_policy(
        self,
        policy: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a new policy."""
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/policies",
            json=policy,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def update_policy(
        self,
        policy_id: str,
        updates: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Partially update a policy (HTTP PATCH)."""
        return await self._request(
            "PATCH", f"/policies/{policy_id}", json=updates, timeout=timeout
        )

    async def delete_policy(
        self,
        policy_id: str,
        *,
        timeout: float | None = None,
    ) -> None:
        """Delete a policy."""
        await self._request("DELETE", f"/policies/{policy_id}", timeout=timeout)

    async def get_audit_log(
        self,
        entry_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch a single audit-log entry by ID."""
        return await self._request(
            "GET", f"/audit/{entry_id}", timeout=timeout
        )

    async def list_audit_logs(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        before: str | None = None,
        actor: str | None = None,
        event_type: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """Query the audit log.

        Parameters
        ----------
        limit:
            Maximum number of entries (1-100, default 20).
        after / before:
            Pagination cursors (ISO-8601 timestamps or opaque IDs).
        actor:
            Filter by actor identifier (user ID or service name).
        event_type:
            Filter by event type string.
        timeout:
            Per-request timeout override.
        """
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after
        if before:
            params["before"] = before
        if actor:
            params["actor"] = actor
        if event_type:
            params["event_type"] = event_type

        raw = await self._request(
            "GET", "/audit", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def get_usage(
        self,
        *,
        period: str = "current",
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Retrieve usage statistics for the current billing period.

        Parameters
        ----------
        period:
            Billing period identifier: ``"current"`` (default),
            ``"previous"``, or an ISO-8601 month string such as
            ``"2025-03"``.
        timeout:
            Per-request timeout override.
        """
        return await self._request(
            "GET", "/usage", params={"period": period}, timeout=timeout
        )

    async def get_model(
        self,
        model_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch metadata for a deployed decision model."""
        return await self._request(
            "GET", f"/models/{model_id}", timeout=timeout
        )

    async def list_models(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List available decision models."""
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after

        raw = await self._request(
            "GET", "/models", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def create_model(
        self,
        model: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Register / upload a new decision model."""
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/models",
            json=model,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def update_model(
        self,
        model_id: str,
        updates: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Partially update a model record."""
        return await self._request(
            "PATCH", f"/models/{model_id}", json=updates, timeout=timeout
        )

    async def delete_model(
        self,
        model_id: str,
        *,
        timeout: float | None = None,
    ) -> None:
        """Delete a model record."""
        await self._request("DELETE", f"/models/{model_id}", timeout=timeout)

    async def get_webhook(
        self,
        webhook_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch a webhook configuration by ID."""
        return await self._request(
            "GET", f"/webhooks/{webhook_id}", timeout=timeout
        )

    async def list_webhooks(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List registered webhooks."""
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after

        raw = await self._request(
            "GET", "/webhooks", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def create_webhook(
        self,
        webhook: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Register a new webhook endpoint."""
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/webhooks",
            json=webhook,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def update_webhook(
        self,
        webhook_id: str,
        updates: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Partially update a webhook configuration."""
        return await self._request(
            "PATCH", f"/webhooks/{webhook_id}", json=updates, timeout=timeout
        )

    async def delete_webhook(
        self,
        webhook_id: str,
        *,
        timeout: float | None = None,
    ) -> None:
        """Delete a webhook endpoint."""
        await self._request(
            "DELETE", f"/webhooks/{webhook_id}", timeout=timeout
        )

    async def rotate_api_key(
        self,
        *,
        reason: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Rotate the current API key and return the new key details.

        .. warning::
            This invalidates the current key immediately.  Update
            :attr:`api_key` (or the ``ATLASENT_API_KEY`` env var) before
            making further calls.

        Parameters
        ----------
        reason:
            Optional reason string stored with the rotation event.
        timeout:
            Per-request timeout override.
        """
        body: dict[str, Any] = {}
        if reason:
            body["reason"] = reason

        return await self._request(
            "POST", "/auth/rotate", json=body or None, timeout=timeout
        )

    async def get_organization(
        self,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch the organization record associated with the API key."""
        return await self._request("GET", "/organization", timeout=timeout)

    async def update_organization(
        self,
        updates: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Partially update organization metadata."""
        return await self._request(
            "PATCH", "/organization", json=updates, timeout=timeout
        )

    async def list_members(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        role: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List organization members.

        Parameters
        ----------
        limit:
            Maximum number of results.
        after:
            Pagination cursor.
        role:
            Filter by role (e.g. ``"admin"``, ``"member"``).
        timeout:
            Per-request timeout override.
        """
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after
        if role:
            params["role"] = role

        raw = await self._request(
            "GET", "/members", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def invite_member(
        self,
        email: str,
        role: str,
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Send an invitation to a new organization member.

        Parameters
        ----------
        email:
            Invitee e-mail address.
        role:
            Role to assign on acceptance.
        timeout:
            Per-request timeout override.
        idempotency_key:
            Optional idempotency key.
        """
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/members/invite",
            json={"email": email, "role": role},
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def remove_member(
        self,
        member_id: str,
        *,
        timeout: float | None = None,
    ) -> None:
        """Remove a member from the organization."""
        await self._request(
            "DELETE", f"/members/{member_id}", timeout=timeout
        )

    async def update_member_role(
        self,
        member_id: str,
        role: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Update a member's role."""
        return await self._request(
            "PATCH",
            f"/members/{member_id}",
            json={"role": role},
            timeout=timeout,
        )

    async def get_environment(
        self,
        env_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch an environment by ID."""
        return await self._request(
            "GET", f"/environments/{env_id}", timeout=timeout
        )

    async def list_environments(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List all environments."""
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after

        raw = await self._request(
            "GET", "/environments", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def create_environment(
        self,
        env: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a new environment."""
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/environments",
            json=env,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def update_environment(
        self,
        env_id: str,
        updates: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Partially update an environment."""
        return await self._request(
            "PATCH", f"/environments/{env_id}", json=updates, timeout=timeout
        )

    async def delete_environment(
        self,
        env_id: str,
        *,
        timeout: float | None = None,
    ) -> None:
        """Delete an environment."""
        await self._request(
            "DELETE", f"/environments/{env_id}", timeout=timeout
        )

    async def get_feature_flag(
        self,
        flag_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch a feature flag by ID."""
        return await self._request(
            "GET", f"/feature-flags/{flag_id}", timeout=timeout
        )

    async def list_feature_flags(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        enabled: bool | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List feature flags."""
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after
        if enabled is not None:
            params["enabled"] = str(enabled).lower()

        raw = await self._request(
            "GET", "/feature-flags", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def create_feature_flag(
        self,
        flag: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a new feature flag."""
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/feature-flags",
            json=flag,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def update_feature_flag(
        self,
        flag_id: str,
        updates: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Partially update a feature flag."""
        return await self._request(
            "PATCH", f"/feature-flags/{flag_id}", json=updates, timeout=timeout
        )

    async def delete_feature_flag(
        self,
        flag_id: str,
        *,
        timeout: float | None = None,
    ) -> None:
        """Delete a feature flag."""
        await self._request(
            "DELETE", f"/feature-flags/{flag_id}", timeout=timeout
        )

    async def get_segment(
        self,
        segment_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch a segment by ID."""
        return await self._request(
            "GET", f"/segments/{segment_id}", timeout=timeout
        )

    async def list_segments(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List segments."""
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after

        raw = await self._request(
            "GET", "/segments", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def create_segment(
        self,
        segment: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a new segment."""
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/segments",
            json=segment,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def update_segment(
        self,
        segment_id: str,
        updates: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Partially update a segment."""
        return await self._request(
            "PATCH", f"/segments/{segment_id}", json=updates, timeout=timeout
        )

    async def delete_segment(
        self,
        segment_id: str,
        *,
        timeout: float | None = None,
    ) -> None:
        """Delete a segment."""
        await self._request(
            "DELETE", f"/segments/{segment_id}", timeout=timeout
        )

    async def get_experiment(
        self,
        experiment_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch an A/B experiment by ID."""
        return await self._request(
            "GET", f"/experiments/{experiment_id}", timeout=timeout
        )

    async def list_experiments(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        status: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List A/B experiments."""
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after
        if status:
            params["status"] = status

        raw = await self._request(
            "GET", "/experiments", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def create_experiment(
        self,
        experiment: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Create a new A/B experiment."""
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/experiments",
            json=experiment,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def start_experiment(
        self,
        experiment_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Start a paused or draft experiment."""
        return await self._request(
            "POST", f"/experiments/{experiment_id}/start", timeout=timeout
        )

    async def stop_experiment(
        self,
        experiment_id: str,
        *,
        winner_variant_id: str | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Stop a running experiment.

        Parameters
        ----------
        experiment_id:
            Experiment to stop.
        winner_variant_id:
            Optional winning variant; recorded on the experiment record.
        timeout:
            Per-request timeout override.
        """
        body: dict[str, Any] = {}
        if winner_variant_id:
            body["winner_variant_id"] = winner_variant_id

        return await self._request(
            "POST",
            f"/experiments/{experiment_id}/stop",
            json=body or None,
            timeout=timeout,
        )

    async def get_experiment_results(
        self,
        experiment_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch aggregated results for an experiment."""
        return await self._request(
            "GET", f"/experiments/{experiment_id}/results", timeout=timeout
        )

    async def list_events(
        self,
        *,
        limit: int = 20,
        after: str | None = None,
        event_type: str | None = None,
        subject_id: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """Query the event stream.

        Parameters
        ----------
        limit:
            Maximum results (1-100, default 20).
        after:
            Pagination cursor.
        event_type:
            Filter by event type string.
        subject_id:
            Filter events by subject entity ID.
        timeout:
            Per-request timeout override.
        """
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after
        if event_type:
            params["event_type"] = event_type
        if subject_id:
            params["subject_id"] = subject_id

        raw = await self._request(
            "GET", "/events", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def emit_event(
        self,
        event: dict[str, Any],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Emit a custom event to the AtlaSent event stream."""
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/events",
            json=event,
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def get_score(
        self,
        entity_id: str,
        score_type: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch the latest risk / trust score for an entity.

        Parameters
        ----------
        entity_id:
            The entity (user, account, etc.) identifier.
        score_type:
            Score category, e.g. ``"risk"``, ``"trust"``.
        timeout:
            Per-request timeout override.
        """
        return await self._request(
            "GET",
            f"/scores/{entity_id}/{score_type}",
            timeout=timeout,
        )

    async def list_scores(
        self,
        entity_id: str,
        *,
        limit: int = 20,
        after: str | None = None,
        timeout: float | None = None,
    ) -> list[dict[str, Any]]:
        """List all score types for an entity."""
        params: dict[str, Any] = {"limit": limit}
        if after:
            params["after"] = after

        raw = await self._request(
            "GET", f"/scores/{entity_id}", params=params, timeout=timeout
        )
        return raw.get("data", [])

    async def bulk_decide(
        self,
        requests: list[DecisionRequest | dict[str, Any]],
        *,
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> list[DecisionResponse]:
        """Submit multiple decision requests in a single HTTP call.

        Parameters
        ----------
        requests:
            List of :class:`DecisionRequest` instances or plain dicts.
        timeout:
            Per-request timeout override.
        idempotency_key:
            Optional idempotency key applied to the batch.
        """
        coerced = [
            r if isinstance(r, DecisionRequest) else DecisionRequest(**r)
            for r in requests
        ]
        body = [
            r.model_dump(mode="json", exclude_none=True) for r in coerced
        ]

        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        raw = await self._request(
            "POST",
            "/decisions/bulk",
            json={"requests": body},
            timeout=timeout,
            extra_headers=extra_headers,
        )
        return [
            DecisionResponse.model_validate(item)
            for item in raw.get("results", [])
        ]

    async def explain_decision(
        self,
        decision_id: str,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Fetch a human-readable explanation for a decision."""
        return await self._request(
            "GET",
            f"/decisions/{decision_id}/explain",
            timeout=timeout,
        )

    async def validate_rule(
        self,
        rule: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Dry-run validate a rule definition without persisting it."""
        return await self._request(
            "POST", "/rules/validate", json=rule, timeout=timeout
        )

    async def test_rule(
        self,
        rule_id: str,
        sample: dict[str, Any],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Run a rule against a sample payload to preview its output.

        Parameters
        ----------
        rule_id:
            The rule to test.
        sample:
            Sample decision request payload to evaluate.
        timeout:
            Per-request timeout override.
        """
        return await self._request(
            "POST",
            f"/rules/{rule_id}/test",
            json={"sample": sample},
            timeout=timeout,
        )

    async def simulate_policy(
        self,
        policy_id: str,
        scenarios: list[dict[str, Any]],
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Simulate a policy against a list of scenario payloads.

        Parameters
        ----------
        policy_id:
            Policy to simulate.
        scenarios:
            List of scenario dicts to run through the policy.
        timeout:
            Per-request timeout override.
        """
        return await self._request(
            "POST",
            f"/policies/{policy_id}/simulate",
            json={"scenarios": scenarios},
            timeout=timeout,
        )

    async def export_decisions(
        self,
        *,
        format: str = "jsonl",
        after: str | None = None,
        before: str | None = None,
        status: str | None = None,
        timeout: float | None = None,
    ) -> bytes:
        """Export decisions in bulk.

        Parameters
        ----------
        format:
            Export format: ``"jsonl"`` (default) or ``"csv"``.
        after / before:
            Filter by creation timestamp (ISO-8601).
        status:
            Filter by status string.
        timeout:
            Per-request timeout override.

        Returns
        -------
        bytes
            Raw export content in the requested format.
        """
        params: dict[str, Any] = {"format": format}
        if after:
            params["after"] = after
        if before:
            params["before"] = before
        if status:
            params["status"] = status

        effective_timeout = timeout if timeout is not None else self._timeout
        response = await self._client.get(
            f"{self._base_url}/decisions/export",
            params=params,
            headers=self._base_headers(),
            timeout=httpx.Timeout(effective_timeout, connect=self._connect_timeout),
        )
        _raise_for_status(response)
        return response.content

    async def import_rules(
        self,
        rules: list[dict[str, Any]],
        *,
        mode: str = "upsert",
        timeout: float | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        """Bulk-import rules.

        Parameters
        ----------
        rules:
            List of rule definition dicts.
        mode:
            Import mode: ``"upsert"`` (default) or ``"replace"``.
        timeout:
            Per-request timeout override.
        idempotency_key:
            Optional idempotency key.
        """
        extra_headers: dict[str, str] = {}
        if idempotency_key:
            extra_headers["Idempotency-Key"] = idempotency_key

        return await self._request(
            "POST",
            "/rules/import",
            json={"rules": rules, "mode": mode},
            timeout=timeout,
            extra_headers=extra_headers,
        )

    async def get_rate_limit_status(
        self,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Return the caller's current rate-limit counters."""
        return await self._request(
            "GET", "/auth/rate-limit", timeout=timeout
        )

    async def health_check(
        self,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Ping the API health endpoint."""
        return await self._request("GET", "/health", timeout=timeout)

    async def get_api_version(
        self,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        """Return server-reported API version metadata."""
        return await self._request("GET", "/version", timeout=timeout)

    # ── internals ─────────────────────────────────────────────────────────────

    def _base_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": f"atlasent-python/{VERSION}",
        }

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        params: dict[str, Any] | None = None,
        timeout: float | None = None,
        extra_headers: dict[str, str] | None = None,
    ) -> Any:
        """Send an HTTP request with retry logic and error mapping."""
        url = f"{self._base_url}{path}"
        effective_timeout = timeout if timeout is not None else self._timeout
        headers = {**self._base_headers(), **(extra_headers or {})}
        attempt = 0

        while True:
            attempt += 1
            try:
                response = await self._client.request(
                    method,
                    url,
                    json=json,
                    params=params,
                    headers=headers,
                    timeout=httpx.Timeout(
                        effective_timeout, connect=self._connect_timeout
                    ),
                )
            except httpx.TimeoutException as exc:
                if attempt > self._retry_config.max_retries:
                    raise AtlaSentError(
                        f"{method} {path}: request timed out",
                        code="timeout",
                    ) from exc
                backoff = self._retry_config.backoff(attempt)
                logger.debug(
                    "timeout on %s %s (attempt %d); retrying in %.2fs",
                    method,
                    path,
                    attempt,
                    backoff,
                )
                await asyncio.sleep(backoff)
                continue
            except httpx.RequestError as exc:
                raise AtlaSentError(
                    f"{method} {path}: network error: {exc}",
                    code="network_error",
                ) from exc

            if response.status_code == 429:
                if attempt > self._retry_config.max_retries:
                    raise RateLimitError(
                        retry_after=_parse_retry_after(response),
                        request_id=_request_id(response),
                    )
                backoff = _parse_retry_after(response) or self._retry_config.backoff(
                    attempt
                )
                logger.debug(
                    "rate-limited on %s %s (attempt %d); retrying in %.2fs",
                    method,
                    path,
                    attempt,
                    backoff,
                )
                await asyncio.sleep(backoff)
                continue

            if response.status_code >= 500 and should_retry(
                response.status_code, self._retry_config
            ):
                if attempt > self._retry_config.max_retries:
                    _raise_for_status(response, method=method, path=path)
                backoff = self._retry_config.backoff(attempt)
                logger.debug(
                    "server error %d on %s %s (attempt %d); retrying in %.2fs",
                    response.status_code,
                    method,
                    path,
                    attempt,
                    backoff,
                )
                await asyncio.sleep(backoff)
                continue

            _raise_for_status(response, method=method, path=path)
            return _parse_response(response, method=method, path=path)


# ── module-level helpers ──────────────────────────────────────────────────────


def _request_id(response: httpx.Response) -> str | None:
    return response.headers.get("X-Request-Id") or response.headers.get(
        "X-AtlaSent-Request-Id"
    )


def _parse_retry_after(response: httpx.Response) -> float | None:
    value = response.headers.get("Retry-After")
    if value is None:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _raise_for_status(
    response: httpx.Response,
    *,
    method: str = "",
    path: str = "",
    request_id: str | None = None,
) -> None:
    """Map HTTP error status codes to typed SDK exceptions."""
    if response.status_code < 400:
        return

    rid = request_id or _request_id(response)
    prefix = f"{method} {path}: " if method else ""

    try:
        payload = response.json()
    except Exception:
        payload = {}

    message = payload.get("message") or payload.get("error") or response.text
    code = payload.get("code") or payload.get("error_code")

    if response.status_code == 401:
        raise AuthenticationError(
            f"{prefix}{message or 'authentication failed'}",
            status_code=response.status_code,
            code=code or "authentication_error",
            request_id=rid,
        )
    if response.status_code == 429:
        raise RateLimitError(
            retry_after=_parse_retry_after(response),
            request_id=rid,
        )

    raise AtlaSentError(
        f"{prefix}{message or response.text or 'unknown error'}",
        status_code=response.status_code,
        code=code or "api_error",
        request_id=rid,
    )


def _parse_response(
    response: httpx.Response,
    *,
    method: str = "",
    path: str = "",
) -> Any:
    """Decode a successful JSON response body."""
    if not response.content:
        return None

    content_type = response.headers.get("Content-Type", "")
    if "application/json" not in content_type:
        warnings.warn(
            f"Unexpected Content-Type '{content_type}' for {method} {path}; "
            "returning raw text.",
            stacklevel=4,
        )
        return response.text

    request_id = _request_id(response)
    try:
        return response.json()
    except Exception as exc:
        raise AtlaSentError(
            f"{method} {path}: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc


# ── SSE parser ───────────────────────────────────────────────────────────────────────────────────


async def _parse_sse(
    lines: AsyncIterator[str],
    request_id: str,
    timeout_s: float = 0.0,
    on_event_id: Any = None,
) -> AsyncIterator[StreamDecisionEvent | StreamProgressEvent]:
    """Parse server-sent events from an async line iterator.

    Yields :class:`StreamDecisionEvent` and :class:`StreamProgressEvent`.

    Parameters
    ----------
    lines:
        Async iterator of raw text lines (newline stripped).
    request_id:
        Request correlation ID for error attribution.
    timeout_s:
        If > 0, raise :exc:`AtlaSentError` when a dispatch timeout
        exceeds this many seconds.
    on_event_id:
        Optional async callable invoked with each ``id:`` field value.
    """
    event_type: str | None = None
    data_lines: list[str] = []
    event_id: str | None = None
    last_dispatch: float = 0.0

    async for line in lines:
        if not line:
            # blank line → dispatch accumulated event
            if data_lines:
                data = "\n".join(data_lines)
                yield _dispatch_sse_event(
                    event_type=event_type,
                    data=data,
                    request_id=request_id,
                )
                if on_event_id and event_id is not None:
                    if asyncio.iscoroutinefunction(on_event_id):
                        await on_event_id(event_id)
                    else:
                        on_event_id(event_id)
            event_type = None
            data_lines = []
            event_id = None
            if timeout_s > 0:
                now = asyncio.get_event_loop().time()
                if last_dispatch > 0 and (now - last_dispatch) > timeout_s:
                    raise AtlaSentError(
                        "SSE stream: dispatch timeout exceeded",
                        code="stream_timeout",
                        request_id=request_id,
                    )
                last_dispatch = now
            continue

        if line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" "))
        elif line.startswith("event:"):
            event_type = line[6:].strip()
        elif line.startswith("id: ") or line.startswith("id:"):
            event_id = line.split(":", 1)[1].strip()
