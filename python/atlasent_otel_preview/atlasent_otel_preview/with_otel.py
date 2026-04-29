"""Wrap an AtlaSent client with OpenTelemetry span creation.

Python sibling of
``typescript/packages/otel/src/withOtel.ts``. Same span names,
same attributes, same error-handling shape.

Two entry points:

  * ``with_otel(client, tracer)``       → wraps a sync client
  * ``with_async_otel(client, tracer)`` → wraps an async client
  * ``with_otel_protect(fn, tracer)``   → wraps the top-level
                                          ``atlasent.protect`` fn

Each call runs the wrapped method inside an OTel span. Span
attributes are namespaced under ``atlasent.*`` so they don't
collide with caller-supplied base attributes. On error, span status
flips to ERROR; ``atlasent.error_code`` and ``atlasent.request_id``
surface when the underlying error carries them (matches v1's
``AtlaSentError`` shape).
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, TypeVar

from opentelemetry import trace
from opentelemetry.trace import SpanKind, Status, StatusCode, Tracer

T = TypeVar("T")

_DEFAULT_PREFIX = "atlasent."


# ── Public entry points ──────────────────────────────────────────────


def with_otel(
    client: Any,
    tracer: Tracer,
    attributes: Mapping[str, Any] | None = None,
    span_name_prefix: str = _DEFAULT_PREFIX,
) -> _SyncOtelWrapper:
    """Wrap a sync :class:`atlasent.AtlaSentClient` with OTel spans."""
    return _SyncOtelWrapper(
        client,
        tracer=tracer,
        base_attributes=dict(attributes or {}),
        span_name_prefix=span_name_prefix,
    )


def with_async_otel(
    client: Any,
    tracer: Tracer,
    attributes: Mapping[str, Any] | None = None,
    span_name_prefix: str = _DEFAULT_PREFIX,
) -> _AsyncOtelWrapper:
    """Wrap an async :class:`atlasent.AsyncAtlaSentClient` with OTel spans."""
    return _AsyncOtelWrapper(
        client,
        tracer=tracer,
        base_attributes=dict(attributes or {}),
        span_name_prefix=span_name_prefix,
    )


def with_otel_protect(
    protect_fn: Callable[..., T],
    tracer: Tracer,
    attributes: Mapping[str, Any] | None = None,
    span_name_prefix: str = _DEFAULT_PREFIX,
) -> Callable[..., T]:
    """Wrap the top-level ``atlasent.protect()`` function with OTel spans."""
    base_attrs = dict(attributes or {})

    def wrapped(*args: Any, **kwargs: Any) -> T:
        attrs = dict(base_attrs)
        agent = kwargs.get("agent")
        action = kwargs.get("action")
        if isinstance(agent, str):
            attrs["atlasent.agent"] = agent
        if isinstance(action, str):
            attrs["atlasent.action"] = action

        with tracer.start_as_current_span(
            f"{span_name_prefix}protect",
            kind=SpanKind.CLIENT,
            attributes=attrs,
        ) as span:
            try:
                result = protect_fn(*args, **kwargs)
                span.set_status(Status(StatusCode.OK))
                _safe_record(_record_protect_result, result)
                return result
            except Exception as err:
                _record_error(span, err)
                raise

    return wrapped


# ── Wrapper base ─────────────────────────────────────────────────────


class _OtelWrapperBase:
    """Shared state + helpers for sync/async wrappers."""

    def __init__(
        self,
        client: Any,
        *,
        tracer: Tracer,
        base_attributes: dict[str, Any],
        span_name_prefix: str,
    ) -> None:
        self._client = client
        self._tracer = tracer
        self._base_attrs = base_attributes
        self._prefix = span_name_prefix

    def _attrs_for(self, **fields: Any) -> dict[str, Any]:
        out: dict[str, Any] = dict(self._base_attrs)
        for k, v in fields.items():
            if v is not None:
                out[k] = v
        return out


class _SyncOtelWrapper(_OtelWrapperBase):
    """Forwards sync method calls to ``client``, surrounded by spans."""

    def evaluate(self, action_type: str, actor_id: str, context=None):
        return self._call(
            "evaluate",
            "evaluate",
            self._attrs_for(
                **{
                    "atlasent.action": action_type,
                    "atlasent.agent": actor_id,
                }
            ),
            _record_evaluate_result,
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
            self._attrs_for(**{"atlasent.permit_token": permit_token}),
            _record_verify_result,
            permit_token,
            action_type,
            actor_id,
            context,
        )

    def protect(self, *, agent: str, action: str, context=None):
        return self._call(
            "protect",
            "protect",
            self._attrs_for(
                **{"atlasent.agent": agent, "atlasent.action": action}
            ),
            _record_protect_result,
            agent=agent,
            action=action,
            context=context,
        )

    def authorize(self, *, agent: str, action: str, context=None, **kwargs):
        return self._call(
            "authorize",
            "authorize",
            self._attrs_for(
                **{"atlasent.agent": agent, "atlasent.action": action}
            ),
            _record_authorize_result,
            agent=agent,
            action=action,
            context=context,
            **kwargs,
        )

    def gate(self, action_type: str, actor_id: str, context=None):
        return self._call(
            "gate",
            "gate",
            self._attrs_for(
                **{
                    "atlasent.action": action_type,
                    "atlasent.agent": actor_id,
                }
            ),
            _no_record,
            action_type,
            actor_id,
            context,
        )

    def key_self(self):
        return self._call(
            "key_self",
            "key_self",
            self._attrs_for(),
            _record_key_self_result,
        )

    def list_audit_events(self, **kwargs):
        return self._call(
            "list_audit_events",
            "list_audit_events",
            self._attrs_for(),
            _record_list_audit_result,
            **kwargs,
        )

    def create_audit_export(self, **kwargs):
        return self._call(
            "create_audit_export",
            "create_audit_export",
            self._attrs_for(),
            _record_export_result,
            **kwargs,
        )

    def _call(
        self,
        span_suffix: str,
        method_name: str,
        attrs: dict[str, Any],
        recorder: Callable[[Any], None],
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        with self._tracer.start_as_current_span(
            f"{self._prefix}{span_suffix}",
            kind=SpanKind.CLIENT,
            attributes=attrs,
        ) as span:
            try:
                result = getattr(self._client, method_name)(*args, **kwargs)
                span.set_status(Status(StatusCode.OK))
                _safe_record(recorder, result)
                return result
            except Exception as err:
                _record_error(span, err)
                raise


class _AsyncOtelWrapper(_OtelWrapperBase):
    """Forwards async method calls to ``client``, surrounded by spans."""

    async def evaluate(self, action_type: str, actor_id: str, context=None):
        return await self._call(
            "evaluate",
            "evaluate",
            self._attrs_for(
                **{
                    "atlasent.action": action_type,
                    "atlasent.agent": actor_id,
                }
            ),
            _record_evaluate_result,
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
            self._attrs_for(**{"atlasent.permit_token": permit_token}),
            _record_verify_result,
            permit_token,
            action_type,
            actor_id,
            context,
        )

    async def protect(self, *, agent: str, action: str, context=None):
        return await self._call(
            "protect",
            "protect",
            self._attrs_for(
                **{"atlasent.agent": agent, "atlasent.action": action}
            ),
            _record_protect_result,
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
            self._attrs_for(
                **{"atlasent.agent": agent, "atlasent.action": action}
            ),
            _record_authorize_result,
            agent=agent,
            action=action,
            context=context,
            **kwargs,
        )

    async def key_self(self):
        return await self._call(
            "key_self",
            "key_self",
            self._attrs_for(),
            _record_key_self_result,
        )

    async def _call(
        self,
        span_suffix: str,
        method_name: str,
        attrs: dict[str, Any],
        recorder: Callable[[Any], None],
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        with self._tracer.start_as_current_span(
            f"{self._prefix}{span_suffix}",
            kind=SpanKind.CLIENT,
            attributes=attrs,
        ) as span:
            try:
                result = await getattr(self._client, method_name)(*args, **kwargs)
                span.set_status(Status(StatusCode.OK))
                _safe_record(recorder, result)
                return result
            except Exception as err:
                _record_error(span, err)
                raise


# ── Result-recording helpers (one per method shape) ──────────────────


def _safe_record(fn: Callable[[Any], None], result: Any) -> None:
    """Apply a result recorder.

    Recorders are pure (``getattr`` with defaults + ``isinstance``
    checks) and tolerate any result shape. If one ever throws, that's
    a programming error worth surfacing — don't swallow it here.
    """
    fn(result)


def _no_record(_: Any) -> None:
    """No-op recorder for methods that don't surface success attributes."""
    return None


def _current_span() -> trace.Span:
    return trace.get_current_span()


def _record_evaluate_result(result: Any) -> None:
    span = _current_span()
    permit = getattr(result, "permit_token", None)
    audit = getattr(result, "audit_hash", None)
    if isinstance(permit, str) and permit:
        span.set_attribute("atlasent.permit_token", permit)
    if isinstance(audit, str) and audit:
        span.set_attribute("atlasent.audit_hash", audit)


def _record_verify_result(result: Any) -> None:
    span = _current_span()
    valid = getattr(result, "valid", None)
    if isinstance(valid, bool):
        span.set_attribute("atlasent.verified", valid)


def _record_protect_result(result: Any) -> None:
    span = _current_span()
    if not result:
        return
    permit_id = getattr(result, "permit_id", None)
    audit = getattr(result, "audit_hash", None)
    if isinstance(permit_id, str) and permit_id:
        span.set_attribute("atlasent.permit_id", permit_id)
    if isinstance(audit, str) and audit:
        span.set_attribute("atlasent.audit_hash", audit)


def _record_authorize_result(result: Any) -> None:
    span = _current_span()
    permitted = getattr(result, "permitted", None)
    permit_token = getattr(result, "permit_token", None)
    if isinstance(permitted, bool):
        span.set_attribute("atlasent.permitted", permitted)
    if isinstance(permit_token, str) and permit_token:
        span.set_attribute("atlasent.permit_token", permit_token)


def _record_key_self_result(result: Any) -> None:
    span = _current_span()
    key_id = getattr(result, "key_id", None)
    env = getattr(result, "environment", None)
    if isinstance(key_id, str):
        span.set_attribute("atlasent.key_id", key_id)
    if isinstance(env, str):
        span.set_attribute("atlasent.environment", env)


def _record_list_audit_result(result: Any) -> None:
    span = _current_span()
    events = getattr(result, "events", None)
    if isinstance(events, list):
        span.set_attribute("atlasent.event_count", len(events))


def _record_export_result(result: Any) -> None:
    span = _current_span()
    export_id = getattr(result, "export_id", None)
    events = getattr(result, "events", None)
    if isinstance(export_id, str):
        span.set_attribute("atlasent.export_id", export_id)
    if isinstance(events, list):
        span.set_attribute("atlasent.event_count", len(events))


def _record_error(span: trace.Span, err: Exception) -> None:
    span.set_status(Status(StatusCode.ERROR, str(err)))
    span.record_exception(err)
    code = getattr(err, "code", None)
    if isinstance(code, str):
        span.set_attribute("atlasent.error_code", code)
    request_id = getattr(err, "request_id", None)
    if isinstance(request_id, str):
        span.set_attribute("atlasent.request_id", request_id)
