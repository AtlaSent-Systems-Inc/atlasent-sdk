"""``evaluate_batch_polyfilled()`` — runtime polyfill for Pillar 2.

Python sibling of
``typescript/packages/v2-preview/src/evaluateBatchPolyfill.ts``.
Implements the v2 :class:`EvaluateBatchResponse` shape on top of
v1's per-call ``authorize()``. Customers can use the v2 batch
ergonomics today, against the v1 server; when
``POST /v2/evaluate:batch`` ships at v2 GA, swap this for a single
round trip with no caller-side change.

Two entry points:

  * ``evaluate_batch_polyfilled(client, items, ...)``        — sync
  * ``evaluate_batch_polyfilled_async(client, items, ...)``  — async

Both return :class:`EvaluateBatchResponse`.

We use v1's ``authorize(verify=False)`` rather than ``evaluate()``
because authorize returns data on deny instead of raising —
matches the v2 batch shape where denials are tagged-union elements,
not exceptions.

Trade-offs vs. the real v2 server (documented identically with the
TS sibling):
  * N HTTP calls instead of one
  * N rate-limit decrements instead of one
  * No batch-level audit-chain entry (each item gets its own)
  * Pillar 9 payload_hash opt-in is silently ignored — no v1
    consume endpoint to bind a proof to.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Sequence
from typing import Any, Protocol

from .batch import (
    BatchEvaluateAllowItem,
    BatchEvaluateDenyItem,
    BatchEvaluateItem,
    EvaluateBatchResponse,
    build_evaluate_batch_request,
)


class _SyncBatchPolyfillClient(Protocol):
    """Structural type for v1's sync :class:`atlasent.AtlaSentClient`.

    The polyfill checks against this Protocol instead of importing
    ``atlasent`` so it works with any duck-typed client (custom
    transports, in-memory test fakes, ...). The real
    :class:`atlasent.AtlaSentClient` satisfies it naturally.
    """

    def authorize(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = ...,
        verify: bool = ...,
        raise_on_deny: bool = ...,
    ) -> Any: ...


class _AsyncBatchPolyfillClient(Protocol):
    """Same shape as :class:`_SyncBatchPolyfillClient` but async."""

    async def authorize(
        self,
        *,
        agent: str,
        action: str,
        context: dict[str, Any] | None = ...,
        verify: bool = ...,
        raise_on_deny: bool = ...,
    ) -> Any: ...


def evaluate_batch_polyfilled(
    client: _SyncBatchPolyfillClient,
    items: Sequence[BatchEvaluateItem | dict[str, Any]],
    concurrency: int | None = None,
    batch_id: str | None = None,
) -> EvaluateBatchResponse:
    """Synchronous polyfill — runs each item's ``client.authorize``
    serially.

    The sync path doesn't try to thread-pool the HTTP calls (v1's
    sync client uses ``httpx.Client`` which has its own thread
    semantics). For genuine parallelism, use
    :func:`evaluate_batch_polyfilled_async`.

    Args:
        client: A v1 :class:`atlasent.AtlaSentClient` (or anything
            structurally matching :class:`_SyncBatchPolyfillClient`).
        items: 1–1000 :class:`BatchEvaluateItem` instances or dicts.
            Validated via :func:`build_evaluate_batch_request`.
        concurrency: Ignored on the sync path; accepted for API
            parity with the async sibling.
        batch_id: Optional override; defaults to a fresh UUID.

    Returns:
        :class:`EvaluateBatchResponse` — order-preserving;
        ``response.items[i]`` decides ``items[i]``.
    """
    del concurrency  # Sync path doesn't fan out.
    validated_items = _validate(items)
    bid = batch_id or str(uuid.uuid4())

    response_items = []
    for i, item in enumerate(validated_items):
        result = client.authorize(
            agent=item.agent,
            action=item.action,
            context=item.context,
            verify=False,
        )
        response_items.append(_build_response_item(result, i, bid))
    return EvaluateBatchResponse(batch_id=bid, items=response_items)


_DEFAULT_CONCURRENCY = 10


async def evaluate_batch_polyfilled_async(
    client: _AsyncBatchPolyfillClient,
    items: Sequence[BatchEvaluateItem | dict[str, Any]],
    concurrency: int | None = _DEFAULT_CONCURRENCY,
    batch_id: str | None = None,
) -> EvaluateBatchResponse:
    """Async polyfill — runs each item's ``client.authorize`` in
    parallel with an optional concurrency cap.

    Args:
        client: A v1 :class:`atlasent.AsyncAtlaSentClient` (or
            anything structurally matching
            :class:`_AsyncBatchPolyfillClient`).
        items: 1–1000 :class:`BatchEvaluateItem` instances or dicts.
        concurrency: Max evaluate() calls in flight at once.
            Defaults to 10. Pass ``None`` or ``0`` to disable the
            cap (unlimited fan-out).
        batch_id: Optional override; defaults to a fresh UUID.

    Returns:
        Order-preserving :class:`EvaluateBatchResponse`.

    Raises:
        ValueError: On size / shape violations.
        Anything ``client.authorize`` raises: transport / auth /
            rate-limit failures propagate. v1's clean denials
            (``permitted=False`` data) become per-item
            ``permitted: False`` results, not exceptions.
    """
    validated_items = _validate(items)
    bid = batch_id or str(uuid.uuid4())
    cap = concurrency if concurrency and concurrency > 0 else None

    semaphore = asyncio.Semaphore(cap) if cap else None

    async def run_one(
        index: int, item: BatchEvaluateItem
    ) -> BatchEvaluateAllowItem | BatchEvaluateDenyItem:
        if semaphore is not None:
            async with semaphore:
                result = await client.authorize(
                    agent=item.agent,
                    action=item.action,
                    context=item.context,
                    verify=False,
                )
        else:
            result = await client.authorize(
                agent=item.agent,
                action=item.action,
                context=item.context,
                verify=False,
            )
        return _build_response_item(result, index, bid)

    tasks = [
        asyncio.create_task(run_one(i, item))
        for i, item in enumerate(validated_items)
    ]
    response_items = await asyncio.gather(*tasks)
    return EvaluateBatchResponse(batch_id=bid, items=list(response_items))


# ── Internals ────────────────────────────────────────────────────────


def _validate(
    items: Sequence[BatchEvaluateItem | dict[str, Any]],
) -> list[BatchEvaluateItem]:
    """Reuse the v2 builder's validation so size + shape errors fire
    identically to what the real v2 server would emit."""
    request = build_evaluate_batch_request(list(items), "polyfill_validation_only")
    return list(request.requests)


def _build_response_item(
    result: Any,
    index: int,
    batch_id: str,
) -> BatchEvaluateAllowItem | BatchEvaluateDenyItem:
    """Map v1's :class:`atlasent.AuthorizationResult` to the v2
    per-item shape.

    AuthorizationResult fields used:
      * ``permitted``    — bool discriminator
      * ``permit_token`` — v2 ``decision_id``
      * ``audit_hash``   — v2 ``audit_hash``
      * ``reason``       — v2 ``reason``
      * ``timestamp``    — v2 ``timestamp``
    """
    permitted = bool(getattr(result, "permitted", False))
    decision_id = str(getattr(result, "permit_token", "") or "")
    audit_hash = str(getattr(result, "audit_hash", "") or "")
    reason = str(getattr(result, "reason", "") or "")
    timestamp = str(getattr(result, "timestamp", "") or "")
    common = {
        "index": index,
        "decision_id": decision_id,
        "reason": reason,
        "audit_hash": audit_hash,
        "timestamp": timestamp,
        "batch_id": batch_id,
    }
    if permitted:
        return BatchEvaluateAllowItem(permitted=True, **common)
    return BatchEvaluateDenyItem(permitted=False, **common)
