"""AtlaSent authorization wrapper for LangChain tools.

Wraps Python callables with authorize-first semantics before they are
passed to LangChain's ``@tool``, ``StructuredTool.from_function``, or
any other LangChain tool factory:

1. ``client.protect()`` — evaluate + verifyPermit in one fail-closed call
2. Call the original function — only if protect() did not raise

Zero dependency on ``langchain`` or ``langchain-core``. The wrapped
callable has the same ``__name__``, ``__doc__``, and signature as the
original so it drops straight into any LangChain tool factory.

Sync example::

    from atlasent import AtlaSentClient
    from atlasent_langchain import with_langchain_guard

    client = AtlaSentClient(api_key="ask_live_...")

    def search(query: str) -> str:
        return f"Results for {query}"

    guarded_search = with_langchain_guard(search, client, agent="service:bot")

    # Pass to LangChain (import not needed here):
    # from langchain_core.tools import tool
    # langchain_tool = tool(guarded_search)

Async example::

    from atlasent import AsyncAtlaSentClient
    from atlasent_langchain import async_with_langchain_guard

    aclient = AsyncAtlaSentClient(api_key="ask_live_...")

    async def async_search(query: str) -> str:
        return f"Async results for {query}"

    guarded = async_with_langchain_guard(async_search, aclient, agent="service:bot")
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


# ── with_langchain_guard (sync) ───────────────────────────────────────────────

def with_langchain_guard(
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
    signature as *func* and can be passed directly to any LangChain
    sync tool factory.

    Args:
        func: The callable to wrap.
        client: A sync ``AtlaSentClient`` instance.
        agent: Agent identifier (e.g. ``"service:analytics-bot"``).
        action: Action name. Defaults to ``func.__name__``.
        extra_context: Additional context merged into every evaluation.
        on_deny: ``"throw"`` (default) propagates :class:`AtlaSentDeniedError`;
            ``"tool-result"`` returns a :class:`DenialResult` instead.

    Returns:
        A wrapped callable. Pass it to ``@tool``, ``StructuredTool.from_function``,
        etc. as the underlying ``func``.
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

        # Annotate dict results with permit metadata.
        if isinstance(result, dict):
            return {
                **result,
                "_atlasent_permit_id": permit.permit_id,
                "_atlasent_audit_hash": permit.audit_hash,
            }
        return result

    return wrapper


# ── async_with_langchain_guard ────────────────────────────────────────────────

def async_with_langchain_guard(
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
    and signature as *func* and can be passed to any LangChain async tool
    factory (``StructuredTool.from_function(coroutine=func)``, etc.).

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
