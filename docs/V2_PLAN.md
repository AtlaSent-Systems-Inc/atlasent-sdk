# atlasent-sdk V2 Plan

> Companion to the canonical plan: **[atlasent-api/docs/V2_PLAN.md](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/claude/v2-planning/docs/V2_PLAN.md)**.
> This file enumerates only the SDK-side workstreams (TypeScript +
> Python). Product-level rationale, non-goals, and timeline live in the
> canonical plan.
> Status: **draft** — do not merge until v2 releases.

## SDK workstreams

Mapped to the pillars in the canonical plan:

### Pillar 2 — Batch evaluation

- **TypeScript**: `client.evaluateBatch(requests: EvaluateRequest[]): Promise<EvaluateResponse[]>`.
  Preserves input order; failures surface as a tagged union element,
  not a rejected Promise. Back-pressure: one HTTP call against
  `POST /v1/evaluate:batch`, one rate-limit decrement for the batch.
- **Python**: `client.evaluate_batch(requests: list[EvaluateRequest]) -> list[EvaluateResult | AtlaSentDenied]`.
  Async parity: `async_client.evaluate_batch(...)` via `asyncio.gather`
  internally for per-item awaitables once we extend `EvaluateResult`.
- Audit-trail semantics — a single hash-chain entry per batch, listing
  every decision id. SDK exposes `batch_id` on each result for
  correlation.

### Pillar 3 — Streaming subscription client

- **TypeScript**: `client.subscribeDecisions({ since?: string, filters?: DecisionFilters }, onDecision: (ev: DecisionEvent) => void): Unsubscribe`.
  Wraps `EventSource` (Node 18+ has it natively); resumable via
  `Last-Event-ID` using the last-seen `decision_id`.
- **Python**: `async for ev in client.subscribe_decisions(...)`.
  Uses `httpx` stream with a reconnect loop + jittered backoff.
- Both SDKs: typed `DecisionEvent` union (`permit_issued` / `verified` /
  `consumed` / `revoked` / `escalated` / `hold_resolved` / `rate_limit_state`).

### Pillar 8 — Temporal adapter

- New package: `@atlasent/temporal` (TypeScript) + `atlasent-temporal`
  (Python, optional dep on `temporalio`).
- **TypeScript**: `withAtlaSentActivity(activityFn, { action, context })`
  — wraps a Temporal activity so each call goes `evaluate → verify →
  execute → proof`. Permit bound to `Context.current().info.workflowExecution.runId`.
- **Python**: `@atlasent_activity(action=..., context_builder=...)`
  decorator. Same runId binding.
- **Revocation signal**: Workflow signal `revokeAtlaSentPermits()` calls
  the server-side bulk revoke keyed on the workflow run id.

### Pillar 5 — Decision analytics (SDK support)

- Expose typed clients for the new analytics RPCs so customer dashboards
  and reporting pipelines don't have to hand-roll queries.
- `client.analytics.denialTrends(org, window)`, `.policyDrift(...)`,
  `.riskOverTime(...)`, `.agentScorecard(...)`.

## Ergonomics passes (all languages)

- **Retries with jitter + circuit breaker** — v1.4 retries on 5xx /
  timeout but with fixed exponential backoff. v2 adds jitter and an
  opt-in half-open circuit breaker that short-circuits when the
  backend is down.
- **Sentry / OpenTelemetry breadcrumbs** — optional adapter that
  emits a breadcrumb per `evaluate` / `verify` / `protect` without
  requiring the consumer to wire it up.
- **Typed error re-export parity** — `AtlaSentDenied`, `AtlaSentError`,
  `RateLimitError`, `ConfigurationError` stay identically named across
  TS + Python. No `foo_error` vs `FooError` cross-language drift.

## Non-SDK but SDK-adjacent

- **MCP server co-versioning** — if `atlasent-mcp-server` finds a new
  home (archived today), its protocol version pins to SDK minor.
  Document the pin policy here.
- **Contract drift detector** — the SDK repo's `contract/tools/drift.py`
  already flags wire-shape drift across TS + Python. Expand to cover
  batch + streaming + Temporal endpoints as they ship.

## Cross-language parity (must-hold invariants)

Both SDKs keep these properties at GA:

- Identical primary primitive shape: `protect({ agent, action, context })`
  raises on deny, returns verified `Permit`.
- Identical error taxonomy (names + codes).
- Identical wire contract — `contract/tools/drift.py` green on main.
- Identical rate-limit backoff behavior (same header parsing, same
  `Retry-After` semantics).

## Breakage budget

v2 is a minor-bump by default. **No breaking changes** unless they
close a published class of bug:

- Keep `evaluate(action_type, actor_id, context)` positional API.
- Keep `AtlaSentClient({ apiKey })` / `AtlaSentClient(api_key=)` ctor.
- Allow deprecation of `gate()` in favour of `protect()` since `protect`
  subsumes it; mark deprecated in v2.0, remove in v3.

## Open SDK-lead questions

1. **Node floor bump** — v2 requires Node ≥20 for native `EventSource`
   + `AbortSignal.any` (already used in v1.3). OK to drop 18?
2. **Python floor bump** — v2 needs `httpx>=0.27` for the stream reconnect
   semantics. Currently `>=0.24`. Risk?
3. **Temporal adapter distribution** — separate npm / PyPI package, or
   an optional extra on the main package (`pip install atlasent[temporal]`)?
4. **Breadcrumb adapter distribution** — same question.

Do not merge. Stays in draft through v2 GA.
