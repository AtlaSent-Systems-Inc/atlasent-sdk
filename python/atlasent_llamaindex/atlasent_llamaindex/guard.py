"""AtlaSent authorization wrapper for LlamaIndex tools.

Wraps Python callables with authorize-first semantics before they are
passed to LlamaIndex's ``FunctionTool.from_defaults``, ``QueryEngineTool``,
or any other LlamaIndex tool factory:

1. ``client.protect()`` — evaluate + verifyPermit in one fail-closed call
2. Call the original function — only if protect() did not raise

Zero dependency on ``llama-index`` or ``llama-index-core``. The wrapped
callable has the same ``__name__``, ``__doc__``, and signature as the
original so it drops straight into any LlamaIndex tool factory.

Sync example::

    from atlasent import AtlaSentClient
    from atlasent_llamaindex import with_llamaindex_guard

    client = AtlaSentClient(api_key="ask_live_...")

    def search(query: str) -> str:
        return f"Results for {query}"

    guarded_search = with_llamaindex_guard(search, client, agent="service:bot")

    # Pass to LlamaIndex (import not needed here):
    # from llama_index.core.tools import FunctionTool
    # tool = FunctionTool.from_defaults(fn=guarded_search)

Async example::

    from atlasent import AsyncAtlaSentClient
    from atlasent_llamaindex import async_with_llamaindex_guard

    aclient = AsyncAtlaSentClient(api_key="ask_live_...")

    async def async_search(query: str) -> str:
        return f"Async results for {query}"

    guarded = async_with_llamaindex_guard(async_search, aclient, agent="service:bot")
"""

from __future__ import annotations

import functools
from collections.abc import Callable
from typing import Any

from atlasent.exceptions import AtlaSentDeniedError  # type: ignore[import]


# ── DenialResult ──────────────────────────────────────────────────────────────

class DenialResult:
    """Returned instead of raising when ``on_deny='tool-result'``."""

    denied: bool = True

    def __init__(
        self,
        *,
        decision: str,
        evaluation_id: str,
        reason: str,
        audit_hash: str | None = None,
    ) -> None:
        self.decision = decision
        self.evaluation_id = evaluation_id
        self.reason = reason
        self.audit_hash = audit_hash

    def __repr__(self) -> str:
        return (
            f"DenialResult(decision={self.decision!r}, "
            f"evaluation_id={self.evaluation_id!r}, reason={self.reason!r})"
        )


# ── with_llamaindex_guard (sync) ──────────────────────────────────────────────

def with_llamaindex_guard(
    func: Callable[..., Any],
    client: Any,
    *,
    agent: str,
    action: str | None = None,
    extra_context: dict[str, Any] | None = None,
    on_deny: str = "throw",
) -> Callable[..., Any]:
    """Wrap a sync callable with AtlaSent authorization.

    The returned function has the same ``__name__``, ``__doc__``, and
    signature as *func* and can be passed directly to any LlamaIndex
    sync tool factory.

    Args:
        func: The callable to wrap.
        client: A sync ``AtlaSentClient`` instance.
        agent: Agent identifier (e.g. ``"service:knowledge-bot"``).
        action: Action name. Defaults to ``func.__name__``.
        extra_context: Additional context merged into every evaluation.
        on_deny: ``"throw"`` (default) propagates :class:`AtlaSentDeniedError`;
            ``"tool-result"`` returns a :class:`DenialResult` instead.

    Returns:
        A wrapped callable. Pass it to ``FunctionTool.from_defaults(fn=...)``,
        ``QueryEngineTool``, etc. as the underlying function.
    """
    resolved_action = action or func.__name__

    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        ctx: dict[str, Any] = dict(extra_context or {})
        ctx["tool_input"] = kwargs if kwargs else (args[0] if args else {})

        try:
            permit = client.protect(
                agent=agent,
                action=resolved_action,
                context=ctx,
            )
        except AtlaSentDeniedError as exc:
            if on_deny == "tool-result":
                return DenialResult(
                    decision=getattr(exc, "decision", "deny"),
                    evaluation_id=getattr(exc, "evaluation_id", ""),
                    reason=str(exc.reason) if hasattr(exc, "reason") else str(exc),
                    audit_hash=getattr(exc, "audit_hash", None),
                )
            raise
        except Exception as exc:
            if on_deny == "tool-result":
                return DenialResult(
                    decision="error",
                    evaluation_id="",
                    reason=str(exc),
                )
            raise

        result = func(*args, **kwargs)

        if isinstance(result, dict):
            return {
                **result,
                "_atlasent_permit_id": permit.permit_id,
                "_atlasent_audit_hash": permit.audit_hash,
            }
        return result

    return wrapper


# ── async_with_llamaindex_guard ───────────────────────────────────────────────

def async_with_llamaindex_guard(
    func: Callable[..., Any],
    client: Any,
    *,
    agent: str,
    action: str | None = None,
    extra_context: dict[str, Any] | None = None,
    on_deny: str = "throw",
) -> Callable[..., Any]:
    """Wrap an async callable with AtlaSent authorization.

    The returned coroutine function has the same ``__name__``, ``__doc__``,
    and signature as *func* and can be passed to any LlamaIndex async tool
    factory.

    Args:
        func: The async callable to wrap.
        client: An ``AsyncAtlaSentClient`` instance.
        agent: Agent identifier.
        action: Action name. Defaults to ``func.__name__``.
        extra_context: Additional context merged into every evaluation.
        on_deny: ``"throw"`` or ``"tool-result"``.
    """
    resolved_action = action or func.__name__

    @functools.wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        ctx: dict[str, Any] = dict(extra_context or {})
        ctx["tool_input"] = kwargs if kwargs else (args[0] if args else {})

        try:
            permit = await client.protect(
                agent=agent,
                action=resolved_action,
                context=ctx,
            )
        except AtlaSentDeniedError as exc:
            if on_deny == "tool-result":
                return DenialResult(
                    decision=getattr(exc, "decision", "deny"),
                    evaluation_id=getattr(exc, "evaluation_id", ""),
                    reason=str(exc.reason) if hasattr(exc, "reason") else str(exc),
                    audit_hash=getattr(exc, "audit_hash", None),
                )
            raise
        except Exception as exc:
            if on_deny == "tool-result":
                return DenialResult(
                    decision="error",
                    evaluation_id="",
                    reason=str(exc),
                )
            raise

        result = await func(*args, **kwargs)

        if isinstance(result, dict):
            return {
                **result,
                "_atlasent_permit_id": permit.permit_id,
                "_atlasent_audit_hash": permit.audit_hash,
            }
        return result

    return wrapper
