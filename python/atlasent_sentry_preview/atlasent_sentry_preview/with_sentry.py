"""Wrap an AtlaSent client with Sentry breadcrumb emission.

Python sibling of
``typescript/packages/sentry/src/withSentry.ts``. Same breadcrumb
category / message / data shape, same error-handling boundary,
same captureErrors opt-in.

Three entry points:

  * ``with_sentry(client, ...)``        → wraps a sync client
  * ``with_async_sentry(client, ...)``  → wraps an async client
  * ``with_sentry_protect(fn, ...)``    → wraps the top-level
                                          ``atlasent.protect`` fn

Each call runs the wrapped method AND emits one Sentry breadcrumb.
On error, level flips to ``"error"`` and (if ``capture_errors=True``)
``sentry_sdk.capture_exception(err)`` runs as well.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, TypeVar

import sentry_sdk

T = TypeVar("T")


# ── Public entry points ──────────────────────────────────────────────


def with_sentry(
    client: Any,
    extra_data: Mapping[str, Any] | None = None,
    capture_errors: bool = False,
) -> _SyncSentryWrapper:
    """Wrap a sync :class:`atlasent.AtlaSentClient` with Sentry breadcrumbs."""
    return _SyncSentryWrapper(
        client,
        extra_data=dict(extra_data or {}),
        capture_errors=capture_errors,
    )


def with_async_sentry(
    client: Any,
    extra_data: Mapping[str, Any] | None = None,
    capture_errors: bool = False,
) -> _AsyncSentryWrapper:
    """Wrap an async :class:`atlasent.AsyncAtlaSentClient` with Sentry breadcrumbs."""
    return _AsyncSentryWrapper(
        client,
        extra_data=dict(extra_data or {}),
        capture_errors=capture_errors,
    )


def with_sentry_protect(
    protect_fn: Callable[..., T],
    extra_data: Mapping[str, Any] | None = None,
    capture_errors: bool = False,
) -> Callable[..., T]:
    """Wrap the top-level ``atlasent.protect()`` function with Sentry breadcrumbs."""
    base = dict(extra_data or {})

    def wrapped(*args: Any, **kwargs: Any) -> T:
        agent = kwargs.get("agent")
        action = kwargs.get("action")
        pre_data: dict[str, Any] = dict(base)
        if isinstance(agent, str):
            pre_data["agent"] = agent
        if isinstance(action, str):
            pre_data["action"] = action

        try:
            result = protect_fn(*args, **kwargs)
            success_data: dict[str, Any] = {}
            permit_id = getattr(result, "permit_id", None)
            audit_hash = getattr(result, "audit_hash", None)
            if isinstance(permit_id, str) and permit_id:
                success_data["permit_id"] = permit_id
            if isinstance(audit_hash, str) and audit_hash:
                success_data["audit_hash"] = audit_hash
            _emit("protect", "info", {**pre_data, **success_data})
            return result
        except Exception as err:
            _emit("protect", "error", {**pre_data, **_error_data(err)})
            if capture_errors:
                sentry_sdk.capture_exception(err)
            raise

    return wrapped


# ── Wrapper base ─────────────────────────────────────────────────────


class _SentryWrapperBase:
    """Shared state + helpers for sync/async wrappers."""

    def __init__(
        self,
        client: Any,
        *,
        extra_data: dict[str, Any],
        capture_errors: bool,
    ) -> None:
        self._client = client
        self._base_data = extra_data
        self._capture_errors = capture_errors

    def _pre_data(self, **fields: Any) -> dict[str, Any]:
        out: dict[str, Any] = dict(self._base_data)
        for k, v in fields.items():
            if v is not None:
                out[k] = v
        return out


class _SyncSentryWrapper(_SentryWrapperBase):
    """Forwards sync method calls and emits one breadcrumb each."""

    def evaluate(self, action_type: str, actor_id: str, context=None):
        return self._call(
            "evaluate",
            "evaluate",
            self._pre_data(agent=actor_id, action=action_type),
            _evaluate_success_data,
            action_type,
            actor_id,
            context,
        )

    def verify(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context=None,
    ):
        return self._call(
            "verify_permit",
            "verify",
            self._pre_data(permit_token=permit_token),
            _verify_success_data,
            permit_token,
            action_type,
            actor_id,
            context,
        )

    def protect(self, *, agent: str, action: str, context=None):
        return self._call(
            "protect",
            "protect",
            self._pre_data(agent=agent, action=action),
            _protect_success_data,
            agent=agent,
            action=action,
            context=context,
        )

    def authorize(self, *, agent: str, action: str, context=None, **kwargs):
        return self._call(
            "authorize",
            "authorize",
            self._pre_data(agent=agent, action=action),
            _authorize_success_data,
            agent=agent,
            action=action,
            context=context,
            **kwargs,
        )

    def gate(self, action_type: str, actor_id: str, context=None):
        return self._call(
            "gate",
            "gate",
            self._pre_data(action=action_type, agent=actor_id),
            _no_success_data,
            action_type,
            actor_id,
            context,
        )

    def key_self(self):
        return self._call(
            "key_self",
            "key_self",
            self._pre_data(),
            _key_self_success_data,
        )

    def list_audit_events(self, **kwargs):
        return self._call(
            "list_audit_events",
            "list_audit_events",
            self._pre_data(),
            _list_audit_success_data,
            **kwargs,
        )

    def create_audit_export(self, **kwargs):
        return self._call(
            "create_audit_export",
            "create_audit_export",
            self._pre_data(),
            _export_success_data,
            **kwargs,
        )

    def _call(
        self,
        message: str,
        method_name: str,
        pre_data: dict[str, Any],
        success_extractor: Callable[[Any], dict[str, Any]],
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        try:
            result = getattr(self._client, method_name)(*args, **kwargs)
            _emit(message, "info", {**pre_data, **success_extractor(result)})
            return result
        except Exception as err:
            _emit(message, "error", {**pre_data, **_error_data(err)})
            if self._capture_errors:
                sentry_sdk.capture_exception(err)
            raise


class _AsyncSentryWrapper(_SentryWrapperBase):
    """Forwards async method calls and emits one breadcrumb each."""

    async def evaluate(self, action_type: str, actor_id: str, context=None):
        return await self._call(
            "evaluate",
            "evaluate",
            self._pre_data(agent=actor_id, action=action_type),
            _evaluate_success_data,
            action_type,
            actor_id,
            context,
        )

    async def verify(
        self,
        permit_token: str,
        action_type: str = "",
        actor_id: str = "",
        context=None,
    ):
        return await self._call(
            "verify_permit",
            "verify",
            self._pre_data(permit_token=permit_token),
            _verify_success_data,
            permit_token,
            action_type,
            actor_id,
            context,
        )

    async def protect(self, *, agent: str, action: str, context=None):
        return await self._call(
            "protect",
            "protect",
            self._pre_data(agent=agent, action=action),
            _protect_success_data,
            agent=agent,
            action=action,
            context=context,
        )

    async def authorize(
        self, *, agent: str, action: str, context=None, **kwargs
    ):
        return await self._call(
            "authorize",
            "authorize",
            self._pre_data(agent=agent, action=action),
            _authorize_success_data,
            agent=agent,
            action=action,
            context=context,
            **kwargs,
        )

    async def key_self(self):
        return await self._call(
            "key_self",
            "key_self",
            self._pre_data(),
            _key_self_success_data,
        )

    async def _call(
        self,
        message: str,
        method_name: str,
        pre_data: dict[str, Any],
        success_extractor: Callable[[Any], dict[str, Any]],
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        try:
            result = await getattr(self._client, method_name)(*args, **kwargs)
            _emit(message, "info", {**pre_data, **success_extractor(result)})
            return result
        except Exception as err:
            _emit(message, "error", {**pre_data, **_error_data(err)})
            if self._capture_errors:
                sentry_sdk.capture_exception(err)
            raise


# ── Breadcrumb / data helpers ────────────────────────────────────────


def _emit(message: str, level: str, data: dict[str, Any]) -> None:
    sentry_sdk.add_breadcrumb(
        category="atlasent",
        message=message,
        level=level,
        data=data,
    )


def _no_success_data(_: Any) -> dict[str, Any]:
    return {}


def _evaluate_success_data(result: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    permit = getattr(result, "permit_token", None)
    audit = getattr(result, "audit_hash", None)
    if isinstance(permit, str) and permit:
        out["permit_token"] = permit
    if isinstance(audit, str) and audit:
        out["audit_hash"] = audit
    return out


def _verify_success_data(result: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    valid = getattr(result, "valid", None)
    if isinstance(valid, bool):
        out["verified"] = valid
    return out


def _protect_success_data(result: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    if not result:
        return out
    permit_id = getattr(result, "permit_id", None)
    audit = getattr(result, "audit_hash", None)
    if isinstance(permit_id, str) and permit_id:
        out["permit_id"] = permit_id
    if isinstance(audit, str) and audit:
        out["audit_hash"] = audit
    return out


def _authorize_success_data(result: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    permitted = getattr(result, "permitted", None)
    permit_token = getattr(result, "permit_token", None)
    if isinstance(permitted, bool):
        out["permitted"] = permitted
    if isinstance(permit_token, str) and permit_token:
        out["permit_token"] = permit_token
    return out


def _key_self_success_data(result: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    key_id = getattr(result, "key_id", None)
    env = getattr(result, "environment", None)
    if isinstance(key_id, str):
        out["key_id"] = key_id
    if isinstance(env, str):
        out["environment"] = env
    return out


def _list_audit_success_data(result: Any) -> dict[str, Any]:
    events = getattr(result, "events", None)
    if isinstance(events, list):
        return {"event_count": len(events)}
    return {}


def _export_success_data(result: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    export_id = getattr(result, "export_id", None)
    events = getattr(result, "events", None)
    if isinstance(export_id, str):
        out["export_id"] = export_id
    if isinstance(events, list):
        out["event_count"] = len(events)
    return out


def _error_data(err: Exception) -> dict[str, Any]:
    out: dict[str, Any] = {"error_message": str(err)}
    code = getattr(err, "code", None)
    if isinstance(code, str):
        out["error_code"] = code
    request_id = getattr(err, "request_id", None)
    if isinstance(request_id, str):
        out["request_id"] = request_id
    return out
