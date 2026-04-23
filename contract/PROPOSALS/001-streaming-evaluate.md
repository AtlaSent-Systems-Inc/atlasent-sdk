# Proposal 001 — Streaming `/v1-evaluate`

**Status:** `DRAFT`
**Needs decisions from:** API team (wire format), streaming/backend
engineer (termination + reconnect semantics).

## Problem statement

AI agents that do long-running work (multi-step tool use, generation
that emits content incrementally, human-in-the-loop approval flows)
currently have two bad options under the existing synchronous
`/v1-evaluate`:

1. **One big evaluate up front.** Request authorization for the
   entire task, with full context. But the policy engine can't
   re-evaluate when the task's own side-effects (new resources
   touched, external data fetched, a reviewer's interim approval)
   change the context mid-flight. Authorization decisions are
   stale by the time they matter.

2. **One evaluate per tool call.** Every tiny step becomes a new
   round-trip. Latency dominates. The policy engine can't coalesce
   decisions that would be identical. Cost scales with step count,
   not with agent activity.

V1_PLAN calls for streaming evaluate "exposed as an async iterator
(Python `async for`, TS `AsyncIterable`)". This proposal picks a
wire format and SDK shape that both SDKs can implement identically.

## Proposed wire format

**Transport: Server-Sent Events (SSE).** `Content-Type:
text/event-stream`; UTF-8; LF line endings. One endpoint:

```
POST /v1-evaluate-stream
```

Request body is identical to `POST /v1-evaluate` today
(`EvaluateRequest` schema — agent, action, context, api_key) with one
added optional field:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `stream_hint` | object | no | Opaque hints to the policy engine about expected stream shape (e.g. `{"max_duration_ms": 30000}`). Ignored if unknown. |

### Event types

Events are JSON. Each event is emitted as:

```
event: <type>
data: <json>

```

(blank line terminator, per SSE RFC.)

Three event types are defined:

**`event: decision`** — An interim or final policy decision. Same
shape as today's `EvaluateResponse` body, plus a boolean
`is_final`:

```json
{
  "permitted": true,
  "decision_id": "dec_01J8XKQ2",
  "reason": "Operator authorized under GxP policy",
  "audit_hash": "sha256:...",
  "timestamp": "2026-04-23T10:00:00Z",
  "is_final": false
}
```

`is_final: false` → the SDK should keep the iterator open and expect
more events. `is_final: true` → the stream will terminate (via
`event: done`) without further `decision` events. A `decision`
carrying `permitted: false` always has `is_final: true` — a denial
ends the stream. Callers still verify the final permit via
`/v1-verify-permit` as today.

**`event: progress`** — Non-decision metadata (the policy engine is
still evaluating; partial reasoning; intermediate context). Shape
intentionally open so downstream tooling (observability, compliance
dashboards) can evolve without new event types:

```json
{
  "stage": "evaluating_sub_policies",
  "detail": "checking 3 of 7 rules",
  "timestamp": "2026-04-23T10:00:00.500Z"
}
```

SDKs MAY expose `progress` events to callers verbatim (as a discriminated
union) or filter them out; a caller who only cares about allow/deny
can iterate only `decision`-typed events.

**`event: done`** — Terminator. Server closes the connection after
sending. Body is an empty object `{}` reserved for forward-compatibility:

```json
{}
```

### Errors mid-stream

Policy-denied-midstream is a regular `event: decision` with
`permitted: false` (see above). Transport / server errors use SSE's
native error-by-comment mechanism **plus** a typed event:

```
event: error
data: {"code": "server_error", "message": "downstream timeout", "request_id": "req_abc"}

```

SDKs translate `event: error` into the existing `AtlaSentError`
taxonomy (same `code` values as HTTP errors) and abort the iterator.

### Termination matrix

| Condition | Terminator |
|-----------|-----------|
| Final allow | `event: decision` with `is_final: true`, then `event: done` |
| Deny | `event: decision` with `permitted: false`, then `event: done` |
| Transport / server error | `event: error`, then connection close |
| Client aborts | No server terminator; SDK's `AsyncIterator` raises `asyncio.CancelledError` (Python) or the promise rejects with the caller's abort signal (TS) |

## Open questions

1. **Path vs. subtype negotiation.** `POST /v1-evaluate-stream` (new
   path) vs. `POST /v1-evaluate` with `Accept: text/event-stream`
   (content negotiation)? The former is simpler for SDKs; the latter
   is one less URL for adopters to learn. API team to pick.
2. **Reconnect.** Does the server support `Last-Event-ID` resume after
   a dropped connection? If yes: each event needs an `id:` line, and
   SDKs retry with that header. If no: document that interrupted
   streams MUST be re-requested from scratch (idempotency of the
   `decision_id` handles dup-suppression).
3. **Progress event shape.** The proposal leaves `event: progress`
   intentionally open (no required fields). Should it have a minimal
   required set (e.g. `stage`, `timestamp`) so SDKs can type it?
4. **Idle timeout.** SSE requires the client or some proxy layer to
   keep the connection open. If the policy engine has nothing to say
   for 30s, does the server emit a heartbeat comment (`:heartbeat\n`)?
   Default recommendation in the proposal: yes, every 15s.
5. **Policy engine streaming readiness.** Does the current engine
   support emitting interim decisions at all, or would the first
   implementation just send a single `is_final: true` decision after
   completing synchronously? That's still useful (unified SDK shape)
   but worth calling out.
6. **Rate limiting.** Does a streaming connection count as one
   request against the rate-limit bucket, or as ongoing
   consumption? 429 mid-stream: `event: error` with
   `code: rate_limited` + `retry_after_ms`?

## SDK implementation sketch

### TypeScript

```ts
import atlasent from "@atlasent/sdk";

for await (const event of atlasent.protectStream({
  agent: "agent-long-task",
  action: "run_multi_step_workflow",
  context: { workflowId: "wf_abc" },
})) {
  if (event.type === "decision") {
    if (event.permitted === false) {
      // Denied mid-stream — abort the workflow.
      break;
    }
    if (event.is_final) {
      // Got the terminal allow. Stream will close after this.
    }
  } else if (event.type === "progress") {
    ui.setStatus(event.stage);
  }
  // event.type === "error" → throws before the yield, we never see it here.
}
```

Implementation uses native `fetch` + `ReadableStream`. Backpressure is
free via `for await ... of`. Errors throw out of the iterator with the
same `AtlaSentError` codes the non-streaming client uses.

### Python

```python
from atlasent import AsyncAtlaSentClient

async with AsyncAtlaSentClient(api_key="...") as client:
    async for event in client.protect_stream(
        agent="agent-long-task",
        action="run_multi_step_workflow",
        context={"workflow_id": "wf_abc"},
    ):
        if event.type == "decision":
            if not event.permitted:
                break  # denied
            if event.is_final:
                pass  # terminal allow
        elif event.type == "progress":
            logger.info("stage=%s", event.stage)
```

Implementation uses `httpx.AsyncClient.stream()`. `event` is a
pydantic-discriminated union (`DecisionEvent | ProgressEvent |
ErrorEvent`) so static analysis works.

### Error taxonomy

No new top-level codes needed — reuse the existing
`invalid_api_key | forbidden | rate_limited | timeout | network |
bad_response | bad_request | server_error` set. One new code
possible:

- `stream_aborted` — server terminated the stream without a terminal
  `decision` or `error` event. Rare enough it might fold into
  `bad_response`.

## Test vector requirements

New vectors under `contract/vectors/streams/`:

- `stream_allow_minimal.json` — request body + ordered list of SSE
  events, terminating with `decision(is_final=true)` + `done`.
- `stream_interim_progress_then_allow.json` — request body + events
  including 2 `progress` frames interleaved with `decision(is_final=false)`.
- `stream_deny_midstream.json` — request body + a `decision` with
  `permitted=false, is_final=true` + `done`.
- `stream_error_midstream.json` — request body + 1 `progress` + an
  `event: error` with `code: server_error`.

Each vector stored as the literal SSE byte stream (LF line endings,
wrapped in a JSON-safe string for git compatibility) plus the
expected SDK event sequence (post-translation to the
`DecisionEvent | ProgressEvent` types).

## Not in scope for this proposal

- **Bidirectional streaming** (client also emits events). The policy
  engine does not currently accept streaming context updates.
  `/v1-evaluate-stream` is request-response with a streamed response
  body.
- **WebSocket transport.** SSE was chosen for (a) firewall-friendly
  HTTP/2 compatibility, (b) one-way semantics matching the problem,
  (c) no extra client libraries needed in either SDK. If WebSocket
  is required later, it gets its own proposal.
- **Stream to the non-streaming `evaluate()`.** The current sync
  surface stays as-is; `protect_stream` is purely additive.
