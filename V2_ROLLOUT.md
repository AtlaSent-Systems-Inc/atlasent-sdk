# atlasent-sdk — V2 Rollout

**Status:** plan · **Wave:** B (SDKs + MCP) · **Updated:** 2026-05-15

> **V1 GA — 2026-05-17.** V1 substrate frozen — the canonical foundation
> this V2 plan extends. The `/v1/*` wire surface, schema, audit chain,
> and Ed25519-signed export envelope are stable; V2 work in this plan is
> **additive** on V1 (no V1 wire/schema/audit-chain changes ship under V2).
> V2 implementation is unblocked pending umbrella
> [`V2_DECISIONS.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/V2_DECISIONS.md) sign-off.
> Canonical V1 reference: [`atlasent-api/docs/runtime/golden-path-v1.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/docs/runtime/golden-path-v1.md).
> V1 GA closeout PRs: see umbrella [`ROADMAP.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/ROADMAP.md) "V1 GA — what closed" section.

SDK cut of the [umbrella v2 rollout](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/claude/plan-v2-rollout-5IPGF/V2_ROLLOUT.md). This repo is the **publish-gating fan-out point** — `atlasent-action`, `langchain-llamaindex-integration`, `atlasent-mcp-server`, `atlasent-examples`, `gxp-starter`, and three downstream apps all pin against the 2.x tag that ships from here.

## Position

The 1.x SDKs target two endpoints (`/v1-evaluate`, `/v1-verify-permit`). v2 expands the wire surface to the new additive endpoints (`/v1/evaluate/batch`, `/v1/evaluate/stream`, `/v1/graphql`) and ships the `@atlasent/behavior` helper that every behavior-conditioning consumer references. v1.x methods stay available throughout — v2 is additive, not breaking.

## v2 deliverables (Wave B)

| ID | Item | Status |
|---|---|---|
| B.SDK1 | TS — `client.evaluateMany([...])` over `/v1/evaluate/batch`; falls back to per-item loop on `v2_batch=false` | pending |
| B.SDK2 | TS — `client.authorizeStream(...)` async iterator over `/v1/evaluate/stream` (SSE) with 15s heartbeat handling | pending |
| B.SDK3 | TS — `client.graphql(query, vars)` over `/v1/graphql`; admin-key bearer auth | pending |
| B.SDK4 | Python — `client.authorize_many([...])` + `authorize_many_async` | pending |
| B.SDK5 | Python — `client.authorize_stream(...)` (sync iterator + `_async` async iterator); SSE parser | pending |
| B.SDK6 | Python — `client.graphql(...)` mirror | pending |
| B.SDK7 | Go — `client.EvaluateMany(ctx, reqs)` + `client.AuthorizeStream(ctx, req)` channel-based stream | pending |
| B.SDK8 | `@atlasent/types` 2.x — `EvaluateBatchRequest`, `EvaluateBatchResponse`, `EvaluateStreamEvent`, `BvsSnapshot`, `BehaviorCategory`. Lockstep with `atlasent-api/packages/types`. | pending |
| B.SDK9 | **`@atlasent/behavior` helper** — on-device cache of `StateEvent` summary; reads aggregates-only from `behavior-insights` `pattern_entries`; redacted projection only (no raw text). Sister Python package `atlasent.behavior`. | pending |
| B.SDK10 | `AtlaSentEscalateError` — distinct from `AtlaSentDenied`; raised on `decision: "escalate"` so middleware can route to human review | pending |
| B.SDK11 | Publish — npm `@atlasent/sdk@2.0.0` + `@atlasent/types@2.0.0` + `@atlasent/behavior@1.0.0`; PyPI `atlasent==2.0.0`; Go module `v2` tag | **gated** on Wave A api endpoints stable |
| B.SDK12 | Proof-system offline-replay client — `client.replay(decisionId)` verifies decision via signed bundle without backend round-trip; gated by `v2_proof_system` | pending — v3 candidate, sketched in 2.1 minor |

## Tenant-flag matrix

| Flag | Module |
|---|---|
| `v2_batch` | B.SDK1, B.SDK4, B.SDK7 |
| `v2_streaming` | B.SDK2, B.SDK5, B.SDK7 (stream half) |
| `v2_graphql` | B.SDK3, B.SDK6 |
| `v2_behavior_conditioning` | B.SDK9, B.SDK10 |
| `v2_proof_system` | B.SDK12 (when promoted) |

## Behavior Conditioning Layer (B.SDK9)

`@atlasent/behavior` is referenced as "pending" from every Wave-C plan (`atlasent-action` future behavior-aware policy, `langchain-llamaindex-integration` C.LL6, `gxp-starter` HIPAA-pack categories, `atlasent-examples` flow 07). It does not yet exist anywhere. This is the single biggest dangling dependency in the v2 cycle.

Surface:
- `getStateSummary(userId)` — returns the redacted `StateEvent` summary projection (last N) — same shape that crosses the LedgersMe boundary
- `getCategoryAggregate(userId, category)` — per-category counts for `behavior.health.mental`, `…adherence`, `behavior.financial`, `behavior.minor`
- `attachToEvaluate(request, userId)` — convenience: stamps `context.user_state` + `context.bvsSnapshot` onto an `EvaluateRequest`

Aggregates-only contract: the helper never reads raw event text. The wire shape is frozen by `behavior-insights` BI4 (see that repo's plan).

## Sequencing

1. B.SDK8 (`@atlasent/types` 2.x) lockstep with `atlasent-api/packages/types` — must freeze first
2. B.SDK1–B.SDK7 (per-language batch/stream/graphql) can land in parallel once types freeze
3. B.SDK9 (`@atlasent/behavior`) needs `behavior-insights` BI2 (read API) + BI3 (category aggregates)
4. B.SDK10 (`AtlaSentEscalateError`) — tiny, can land any time after B.SDK8
5. B.SDK11 (publish) — held until contract stabilizes; the umbrella plan says "publish held until contract stabilizes"
6. B.SDK12 (proof-system offline replay) — v3 candidate; sketch only in this rollout

## Cross-repo dependencies

- **atlasent-api**: `/v1/evaluate/{batch,stream}`, `/v1/graphql`, frozen `EvaluateStreamEvent` schema (Wave A)
- **atlasent-control-plane**: tenant-flag service; SDK reads flags via small `flagsClient` for client-side fallback behavior on `v2_*=false`
- **behavior-insights**: BI2 (`pattern_entries` read API), BI3 (sensitive-category aggregates), BI4 (frozen `BvsSnapshot` wire shape)
- **openaispec**: GraphQL SDL mirror — open question whether to publish as a separate `@atlasent/graphql-schema` package (per `openaispec/V2_ROLLOUT.md`)
- **atlasent-action**, **langchain-llamaindex-integration**, **atlasent-mcp-server**, **atlasent-examples**, **gxp-starter**: all unblock on B.SDK11 publish

## Out of scope for Wave B

- Mutating GraphQL — read-only in Wave A; mutations stay on REST (per `atlasent-api/V2_ROLLOUT.md`)
- TS package split (`@atlasent/sdk-v2` side-by-side) — current direction is in-place major bump (umbrella open question)
- Temporal Activity wrappers — `v2_temporal` flag is parked; v3 candidate
- Self-hosted-mode SDK helpers — `v2_self_hosted` flag is parked; v3 candidate

## Open questions

- In-place 2.x bump vs side-by-side `@atlasent/sdk-v2` (umbrella open question — SDK owns the call)
- `@atlasent/behavior` package layout: standalone, or peer-exported from `@atlasent/sdk`?
- Stream auth: bearer query param vs cookie vs header (umbrella open question, blocks B.SDK2/B.SDK5)
- Go module path: `v2` semver-major suffix (`github.com/.../atlasent-sdk/go/v2`) or unsuffixed pre-1.0 major?
- Should `evaluateMany` accept a generator/iterable for streaming-large-batch use cases, or only an array?

## Cross-repo links

- Umbrella plan: [`atlasent/V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/claude/plan-v2-rollout-5IPGF/V2_ROLLOUT.md)
- API plan: [`atlasent-api/V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-api/blob/main/V2_ROLLOUT.md)
- Control-plane plan: [`atlasent-control-plane/V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-control-plane/blob/main/V2_ROLLOUT.md)
- Behavior-insights plan: this branch, sibling repo
- Behavior layer spec: [`V2_BEHAVIOR_CONDITIONING_LAYER.md`](https://github.com/AtlaSent-Systems-Inc/atlasent-docs/blob/main/docs/V2_BEHAVIOR_CONDITIONING_LAYER.md)
