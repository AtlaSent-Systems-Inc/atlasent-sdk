"""V2 Wave-A endpoints (V2-D3, V2-D4, V2-D8) — additive on top of v1.

Three additional methods on top of the v1 ``AtlaSentClient`` surface
that target the new ``/v1/evaluate/batch``, ``/v1/evaluate/stream``,
and ``/v1/graphql`` wire endpoints landed in ``atlasent-api`` PRs
#742, #745, and #746.

The v1 substrate is frozen (post-GA 2026-05-17) — this module is
purely additive. Existing 1.x methods (``evaluate``, ``protect``,
``verify``, ``gate``, …) are untouched.

Closed-by-default discipline
----------------------------

Each tenant gates the new endpoints behind ``v2_batch``,
``v2_streaming``, and ``v2_graphql`` flags respectively. When the
flag is off, ``atlasent-api`` returns HTTP 404. The SDK surfaces
that as :class:`FeatureNotEnabledError` so callers can fall back
deterministically (typically to a per-item ``/v1-evaluate`` loop).

The SDK does **not** auto-fall-back — silent fallback can change
billing and audit semantics. The SDK reports; the app decides.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any
from uuid import UUID

from ._version import __version__
from .exceptions import AtlaSentError

if TYPE_CHECKING:
    from .client import AtlaSentClient


# ── Errors ───────────────────────────────────────────────────────────


class FeatureNotEnabledError(AtlaSentError):
    """Raised when a V2 endpoint returns 404 because the tenant
    feature flag is off.

    The three V2 endpoints (``/v1/evaluate/batch``,
    ``/v1/evaluate/stream``, ``/v1/graphql``) are close-by-default
    per tenant. When the corresponding flag is unset, the API returns
    HTTP 404 — the SDK surfaces that as this distinct error so the
    caller can deterministically fall back to the v1 per-item loop.

    Attributes:
        feature: One of ``"batch"``, ``"streaming"``, ``"graphql"`` —
            identifies which tenant flag is gating the endpoint.
        endpoint: The wire path the SDK attempted (for diagnostics).
    """

    def __init__(
        self,
        feature: str,
        endpoint: str,
        *,
        request_id: str | None = None,
    ) -> None:
        self.feature = feature
        self.endpoint = endpoint
        super().__init__(
            f"AtlaSent V2 feature {feature!r} is not enabled for this tenant "
            f"(POST {endpoint} returned 404). Enable the v2_{feature} flag "
            f"or fall back to the v1 per-item /v1-evaluate loop.",
            # `feature_disabled` (not `forbidden`): the request was not
            # denied on authorization grounds — the tenant lacks the
            # `v2_<feature>` flag. Callers branching on
            # `err.code == "forbidden"` would otherwise conflate this
            # with real 403 auth failures.
            status_code=404,
            code="feature_disabled",
            request_id=request_id,
        )


# ── Response shapes ──────────────────────────────────────────────────


@dataclass(frozen=True)
class EvaluateBatchItem:
    """One element of an ``EvaluateBatchResponse.items`` list.

    Preserves input order — ``items[i]`` corresponds to ``request[i]``.
    On a per-item RPC failure the server returns ``decision=None``
    and populates ``error_code``/``error_message`` instead.
    """

    index: int
    decision: str | None
    decision_id: str | None = None
    permit_token: str | None = None
    reason: str | None = None
    error_code: str | None = None
    error_message: str | None = None


@dataclass(frozen=True)
class EvaluateBatchResponse:
    """Response shape for ``POST /v1/evaluate/batch``."""

    batch_id: str
    items: tuple[EvaluateBatchItem, ...]
    partial: bool


@dataclass(frozen=True)
class StreamComplete:
    """Terminal frame for ``POST /v1/evaluate/stream``."""

    batch_id: str
    count: int
    partial: bool


@dataclass(frozen=True)
class StreamDecision:
    """``event: decision`` frame body, surfaced to ``on_decision``."""

    index: int
    decision: str
    decision_id: str | None = None
    permit_token: str | None = None
    reason: str | None = None


@dataclass(frozen=True)
class StreamErrorFrame:
    """``event: error`` frame body — per-item failure, stream continues."""

    index: int
    error_code: str
    message: str


@dataclass(frozen=True)
class GraphQLResponse:
    """Response shape for ``POST /v1/graphql``."""

    data: dict[str, Any] | None
    errors: tuple[dict[str, Any], ...] = ()


# ── Constants ────────────────────────────────────────────────────────

BATCH_PATH = "/v1/evaluate/batch"
STREAM_PATH = "/v1/evaluate/stream"
GRAPHQL_PATH = "/v1/graphql"

#: Maximum items per batch (mirrors the server-side cap, V2-D3).
MAX_BATCH_ITEMS = 100
#: Maximum request body size (mirrors server-side 1MB cap).
MAX_BODY_BYTES = 1_000_000
#: GraphQL document depth cap (V2-D2).
GRAPHQL_MAX_DEPTH = 8


# ── Public API ───────────────────────────────────────────────────────


def evaluate_many(
    client: AtlaSentClient,
    items: list[dict[str, Any]],
    *,
    batch_id: str | None = None,
) -> EvaluateBatchResponse:
    """``POST /v1/evaluate/batch`` — V2-D3.

    One round-trip for up to :data:`MAX_BATCH_ITEMS` evaluate items.
    Items are returned in input order — ``response.items[i].index``
    equals ``i``.

    Args:
        client: An initialised v1 :class:`AtlaSentClient`. The SDK reuses
            the client's auth header, base URL, and HTTP machinery.
        items: List of evaluate request dicts (same shape as v1
            ``/v1-evaluate``). Length must be 1..:data:`MAX_BATCH_ITEMS`.
        batch_id: Optional UUID for idempotency. Server replays the
            same response for repeat batch_ids within the dedup window.

    Returns:
        :class:`EvaluateBatchResponse` with ``items`` in input order.

    Raises:
        FeatureNotEnabledError: When the tenant ``v2_batch`` flag is
            off (server returned 404).
        AtlaSentError: For any other transport/HTTP failure.
        ValueError: When ``items`` is empty, exceeds the cap, or
            ``batch_id`` is not a valid UUID.
    """
    if not items:
        raise ValueError("items must be a non-empty list")
    if len(items) > MAX_BATCH_ITEMS:
        raise ValueError(
            f"items length {len(items)} exceeds maximum of {MAX_BATCH_ITEMS}"
        )
    if batch_id is not None:
        # Validate UUID shape — server rejects non-UUID batch_ids.
        try:
            UUID(batch_id)
        except (ValueError, AttributeError, TypeError) as exc:
            raise ValueError(f"batch_id must be a valid UUID: {batch_id!r}") from exc

    body: dict[str, Any] = {"items": items}
    if batch_id is not None:
        body["batch_id"] = batch_id

    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_BODY_BYTES:
        raise ValueError(
            f"batch body {len(raw)} bytes exceeds maximum of {MAX_BODY_BYTES}"
        )

    response = client._client.post(  # noqa: SLF001 — intentional reuse
        f"{client._base_url}{BATCH_PATH}",  # noqa: SLF001
        content=raw,
        headers={"Content-Type": "application/json"},
    )
    request_id = response.headers.get("X-Request-ID")
    if response.status_code == 404:
        raise FeatureNotEnabledError("batch", BATCH_PATH, request_id=request_id)
    if response.status_code >= 400:
        raise AtlaSentError(
            f"POST {BATCH_PATH} returned {response.status_code}",
            status_code=response.status_code,
            code="server_error" if response.status_code >= 500 else "bad_request",
            request_id=request_id,
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise AtlaSentError(
            "evaluate_many: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc

    return _parse_batch_response(data)


def _parse_batch_response(data: dict[str, Any]) -> EvaluateBatchResponse:
    items_raw = data.get("items") or []
    items: list[EvaluateBatchItem] = []
    for item in items_raw:
        items.append(
            EvaluateBatchItem(
                index=int(item.get("index", -1)),
                decision=item.get("decision"),
                decision_id=item.get("decision_id"),
                permit_token=item.get("permit_token"),
                reason=item.get("reason"),
                error_code=item.get("error_code"),
                error_message=item.get("error_message"),
            )
        )
    return EvaluateBatchResponse(
        batch_id=str(data.get("batch_id", "")),
        items=tuple(items),
        partial=bool(data.get("partial", False)),
    )


def authorize_stream(
    client: AtlaSentClient,
    items: list[dict[str, Any]],
    *,
    batch_id: str | None = None,
    on_decision: Callable[[StreamDecision], None] | None = None,
    on_error: Callable[[StreamErrorFrame], None] | None = None,
) -> StreamComplete:
    """``POST /v1/evaluate/stream`` — V2-D4.

    Streams ``event: decision`` frames in input order, with per-item
    RPC failures surfaced as ``event: error`` frames (the stream
    continues — V2-D7 async semantics). Returns the terminal
    ``event: complete`` payload.

    Args:
        client: An initialised v1 :class:`AtlaSentClient`.
        items: Evaluate request dicts, 1..:data:`MAX_BATCH_ITEMS`.
        batch_id: Optional UUID for idempotency.
        on_decision: Callback invoked for each ``event: decision`` frame.
        on_error: Callback invoked for each ``event: error`` frame.

    Returns:
        :class:`StreamComplete` from the terminal ``event: complete``
        frame.

    Raises:
        FeatureNotEnabledError: When ``v2_streaming`` is off.
        AtlaSentError: For other transport/HTTP failures, including
            stream termination without a ``complete`` frame.
        ValueError: When ``items`` is empty, exceeds the cap, or
            ``batch_id`` is not a valid UUID.
    """
    if not items:
        raise ValueError("items must be a non-empty list")
    if len(items) > MAX_BATCH_ITEMS:
        raise ValueError(
            f"items length {len(items)} exceeds maximum of {MAX_BATCH_ITEMS}"
        )
    if batch_id is not None:
        try:
            UUID(batch_id)
        except (ValueError, AttributeError, TypeError) as exc:
            raise ValueError(f"batch_id must be a valid UUID: {batch_id!r}") from exc

    body: dict[str, Any] = {"items": items}
    if batch_id is not None:
        body["batch_id"] = batch_id

    url = f"{client._base_url}{STREAM_PATH}"  # noqa: SLF001
    headers = {
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
    }

    complete: StreamComplete | None = None
    with client._client.stream(  # noqa: SLF001
        "POST", url, json=body, headers=headers
    ) as response:
        request_id = response.headers.get("X-Request-ID")
        if response.status_code == 404:
            raise FeatureNotEnabledError(
                "streaming", STREAM_PATH, request_id=request_id
            )
        if response.status_code >= 400:
            raise AtlaSentError(
                f"POST {STREAM_PATH} returned {response.status_code}",
                status_code=response.status_code,
                code="server_error" if response.status_code >= 500 else "bad_request",
                request_id=request_id,
            )

        event_name: str | None = None
        for raw_line in response.iter_lines():
            line = (
                raw_line.decode("utf-8")
                if isinstance(raw_line, bytes)
                else raw_line
            )
            if line == "":
                event_name = None
                continue
            if line.startswith(":"):
                # SSE comment / keep-alive heartbeat — ignore.
                continue
            if line.startswith("event:"):
                event_name = line[len("event:") :].strip()
                continue
            if not line.startswith("data:"):
                continue
            data_text = line[len("data:") :].strip()
            try:
                payload = json.loads(data_text)
            except ValueError:
                # Malformed frame — skip rather than tear down the stream.
                continue
            if not isinstance(payload, dict):
                continue
            if event_name == "decision" and on_decision is not None:
                on_decision(
                    StreamDecision(
                        index=int(payload.get("index", -1)),
                        decision=str(payload.get("decision", "")),
                        decision_id=payload.get("decision_id"),
                        permit_token=payload.get("permit_token"),
                        reason=payload.get("reason"),
                    )
                )
            elif event_name == "error" and on_error is not None:
                on_error(
                    StreamErrorFrame(
                        index=int(payload.get("index", -1)),
                        error_code=str(payload.get("error_code", "")),
                        message=str(payload.get("message", "")),
                    )
                )
            elif event_name == "complete":
                complete = StreamComplete(
                    batch_id=str(payload.get("batch_id", "")),
                    count=int(payload.get("count", 0)),
                    partial=bool(payload.get("partial", False)),
                )
                break

    if complete is None:
        raise AtlaSentError(
            "authorize_stream: stream closed without a `complete` event",
            code="bad_response",
        )
    return complete


def graphql(
    client: AtlaSentClient,
    query: str,
    variables: dict[str, Any] | None = None,
    *,
    operation_name: str | None = None,
) -> GraphQLResponse:
    """``POST /v1/graphql`` — V2-D2 + V2-D8.

    Bearer-only auth (no query-param). The Wave A schema is read-only
    (``recentEvaluations(limit)`` + ``activeBundle``). The server
    enforces the V2-D8 OR-gate (``audit:read`` OR ``policy:read``) at
    the request layer and the per-resolver AND-gate at field
    resolution time.

    Args:
        client: An initialised v1 :class:`AtlaSentClient`.
        query: GraphQL document. Server enforces a max depth of
            :data:`GRAPHQL_MAX_DEPTH` and 1 operation per request.
        variables: Optional variable bindings.
        operation_name: Optional named operation selector.

    Returns:
        :class:`GraphQLResponse` with ``data`` and/or ``errors``. The
        SDK does not raise on resolver-level errors — those surface
        on ``response.errors`` so the caller can branch.

    Raises:
        FeatureNotEnabledError: When ``v2_graphql`` is off.
        AtlaSentError: For transport/HTTP failures.
        ValueError: When ``query`` is empty or the body exceeds the
            1MB cap.
    """
    if not query or not query.strip():
        raise ValueError("query must be a non-empty string")

    body: dict[str, Any] = {"query": query}
    if variables is not None:
        body["variables"] = variables
    if operation_name is not None:
        body["operationName"] = operation_name

    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_BODY_BYTES:
        raise ValueError(
            f"graphql body {len(raw)} bytes exceeds maximum of {MAX_BODY_BYTES}"
        )

    response = client._client.post(  # noqa: SLF001
        f"{client._base_url}{GRAPHQL_PATH}",  # noqa: SLF001
        content=raw,
        headers={"Content-Type": "application/json"},
    )
    request_id = response.headers.get("X-Request-ID")
    if response.status_code == 404:
        raise FeatureNotEnabledError("graphql", GRAPHQL_PATH, request_id=request_id)
    if response.status_code >= 400:
        raise AtlaSentError(
            f"POST {GRAPHQL_PATH} returned {response.status_code}",
            status_code=response.status_code,
            code="server_error" if response.status_code >= 500 else "bad_request",
            request_id=request_id,
        )

    try:
        data = response.json()
    except ValueError as exc:
        raise AtlaSentError(
            "graphql: malformed JSON response",
            status_code=response.status_code,
            code="bad_response",
            request_id=request_id,
        ) from exc

    errors_raw = data.get("errors") or ()
    return GraphQLResponse(
        data=data.get("data"),
        errors=tuple(errors_raw),
    )


__all__ = [
    "FeatureNotEnabledError",
    "EvaluateBatchItem",
    "EvaluateBatchResponse",
    "StreamComplete",
    "StreamDecision",
    "StreamErrorFrame",
    "GraphQLResponse",
    "BATCH_PATH",
    "STREAM_PATH",
    "GRAPHQL_PATH",
    "MAX_BATCH_ITEMS",
    "MAX_BODY_BYTES",
    "GRAPHQL_MAX_DEPTH",
    "evaluate_many",
    "authorize_stream",
    "graphql",
    "__version__",
]
