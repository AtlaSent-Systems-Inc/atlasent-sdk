"""Temporal activity decorator that wraps each call with ``protect()``.

Python sibling of
``typescript/packages/temporal/src/withAtlaSentActivity.ts``. Same
shape, same context-enrichment metadata, same call ordering.

Each invocation of the decorated function:

1. Resolves ``action``, ``context_builder``, ``agent`` (literals or
   sync/async callables of the activity input).
2. Reads :func:`temporalio.activity.info` to bind the permit to
   the workflow run id (so retries within the same workflow share
   a permit chain).
3. Calls :func:`atlasent.protect`. On deny, raises
   ``AtlaSentDeniedError`` — Temporal records the activity failure
   and the workflow handles it.
4. On allow, runs the original function and returns its result.

The v2 callback / consume flow is intentionally not wired here —
that requires server-side endpoints from PR #61. Once those land,
this decorator extends to call ``consume`` after the activity
completes and surface the resulting Proof to the workflow.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable
from functools import wraps
from typing import Any, TypeVar

from atlasent import protect as atlasent_protect
from temporalio import activity

T = TypeVar("T")
R = TypeVar("R")

# Resolver: a literal value of type V, or a (sync or async) callable
# of the activity input that returns V. Mirrors the TS Resolver shape.
Resolver = T | Callable[[Any], T] | Callable[[Any], Awaitable[T]]


def atlasent_activity(
    *,
    action: Resolver[str],
    context_builder: Resolver[dict[str, Any]] | None = None,
    agent: Resolver[str] | None = None,
) -> Callable[[Callable[..., Awaitable[R]]], Callable[..., Awaitable[R]]]:
    """Wrap a Temporal activity coroutine with ``protect()``.

    Args:
        action: Action being authorized. A string fixes it; a
            callable lets you derive it from the activity input.
        context_builder: Optional resolver returning the policy
            context dict for the call. Defaults to ``{}``.
        agent: Optional resolver for the agent identifier. Defaults
            to ``"<workflow_id>:<activity_type>"`` so audit logs
            show which workflow + step issued the permit.

    Returns:
        A decorator. Apply to an async activity function::

            @atlasent_activity(
                action="deploy",
                context_builder=lambda input: {"commit": input["commit"]},
            )
            async def deploy(input: dict) -> str:
                ...
    """

    def decorator(
        activity_fn: Callable[..., Awaitable[R]],
    ) -> Callable[..., Awaitable[R]]:
        @wraps(activity_fn)
        async def wrapped(*args: Any, **kwargs: Any) -> R:
            input_value = _activity_input(args, kwargs)
            resolved_action = await _resolve(action, input_value)
            resolved_context = (
                await _resolve(context_builder, input_value)
                if context_builder is not None
                else {}
            )
            resolved_agent = (
                await _resolve(agent, input_value)
                if agent is not None
                else _default_agent()
            )

            enriched = _enrich_context(resolved_context)

            atlasent_protect(
                agent=resolved_agent,
                action=resolved_action,
                context=enriched,
            )
            return await activity_fn(*args, **kwargs)

        return wrapped

    return decorator


# ── Internals ────────────────────────────────────────────────────────


def _activity_input(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Any:
    """Best-effort: pick the activity's input value for resolvers.

    Temporal activities accept a single argument by convention. If
    the function was called with one positional arg, return that.
    If multiple, return the args tuple. If keyword-only, return
    kwargs. The shape stays available for resolver callbacks; the
    activity itself receives the original args/kwargs verbatim.
    """
    if len(args) == 1 and not kwargs:
        return args[0]
    if not args and kwargs:
        return kwargs
    return {"args": args, "kwargs": kwargs}


def _enrich_context(base: dict[str, Any]) -> dict[str, Any]:
    """Augment caller-supplied context with workflow-execution metadata.

    Namespaced under ``_atlasent_temporal`` so user-supplied context
    can't accidentally collide.
    """
    info = activity.info()
    return {
        **base,
        "_atlasent_temporal": {
            "workflow_id": info.workflow_id,
            "run_id": info.workflow_run_id,
            "activity_id": info.activity_id,
            "activity_type": info.activity_type,
            "attempt": info.attempt,
        },
    }


def _default_agent() -> str:
    info = activity.info()
    return f"{info.workflow_id}:{info.activity_type}"


async def _resolve(value: Resolver[T], input_value: Any) -> T:
    """Apply a resolver — literal, sync callable, or async callable."""
    if callable(value):
        result = value(input_value)
        if inspect.isawaitable(result):
            return await result  # type: ignore[no-any-return]
        return result  # type: ignore[return-value]
    return value
