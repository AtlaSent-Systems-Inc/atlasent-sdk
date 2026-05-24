# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

---

## @atlasent/sdk 2.7.0 (2026-05-24)

### New features

#### `client.replay()` — decision replay (ADR-015 Phase C)

The third parity runtime from `POLICY_PARITY_CONTRACT.md` lands as
`AtlaSentClient.replay()`. Given a prior evaluation ID, it re-evaluates the
original decision against the **pinned** policy bundle and engine version
recorded at decision time, then reports whether the outcome has drifted.

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey });
const result = await client.replay({ evaluationId });

switch (result.varianceKind) {
  case "NONE":
    // deterministic — decision unchanged
    break;
  case "POLICY_DRIFT":
    // policy bundle was updated; re-evaluation changed the outcome
    console.warn("drift:", result.originalDecision, "→", result.replayedDecision);
    break;
  case "ENVELOPE_DRIFT":
    // context envelope mismatch — audit chain integrity concern
    break;
  case "ENGINE_DRIFT":
    // engine version retired; replay not supported for this record
    break;
  case "BUNDLE_MISSING":
    // pinned bundle no longer resolvable
    break;
}
```

**Wire path:** `POST /v1/decisions/:id/replay`

**Side effects:** none — audit chain writes, permit issuance, webhooks, and
metering are all suppressed in replay mode (ADR-016 `mode: "replay"` sentinel).

**Variance kinds** (`ReplayVarianceKind`):
`"NONE"` | `"POLICY_DRIFT"` | `"ENVELOPE_DRIFT"` | `"ENGINE_DRIFT"` |
`"CHAIN_TAMPER"` | `"BUNDLE_MISSING"` — closed set from
`POLICY_PARITY_CONTRACT.md §Replay`.

The SDK is now the third parity runtime (alongside the V1 wire evaluator and
the control-plane OPA bundle) and its conformance vectors in
`contract/vectors/replay.json` join the `@atlasent/contract-parity` suite.

### Types

New exports:
- `ReplayRequest` — input type for `client.replay()`
- `ReplayResponse` — result type (includes `varianceKind`, `originalDecision`,
  `replayedDecision`, `engineVersion`, `envelopeVerification`, `replayedAt`, `rateLimit`)
- `ReplayVarianceKind` — closed union of the six variance kinds

### Testing

9 new tests in `test/client-replay.test.ts`. Coverage: NONE, POLICY_DRIFT,
ENVELOPE_DRIFT, ENGINE_DRIFT, BUNDLE_MISSING, URL path, HTTP method, rate-limit
header parsing, and missing `decision_id` fallback.

---

## @atlasent/sdk 2.6.0 (2026-05-22)

### New features

#### Constrained governance agents — advisory read surface

Three new client methods that wrap the `v1-governance-agents` edge
function in atlasent-api, plus the wire types and a severity rollup
helper. **Read-only by design** — there is no invocation method on
the SDK. Agent invocation is a CI concern (atlasent-action's
`governance-agents` mode), not an application concern.

```ts
import { AtlaSentClient, highestAgentFindingSeverity } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey });

// Registry: who is allowed to evaluate?
const agents = await client.listGovernanceAgents();
// Every row has authority_class === "advisory" and can_authorize === false.

// Findings against one governed change:
const findings = await client.listGovernanceFindings({
  change_id: "00000000-0000-0000-0000-000000000042",
  agent_slug: "migration_review", // optional filter
});
const worst = highestAgentFindingSeverity(findings); // null | "info" | ... | "blocker"

// Run records (including failed / timeout / completed-with-zero-findings):
const evaluations = await client.listGovernanceEvaluations({
  change_id: "00000000-0000-0000-0000-000000000042",
});
```

**Doctrine — evaluation ≠ authorization ≠ execution.** Both
`GovernanceAgent.can_authorize` and `GovernanceAgentFinding.can_authorize`
are typed as the literal `false`, mirroring the structural invariant
that no row in either table can ever satisfy a gate or clear a hold.
TypeScript compilation enforces this at every consumer call site.

### Types

New exports from the package entry point:

- `GovernanceAgent`, `GovernanceAgentFinding`, `GovernanceAgentEvaluation`
- `AgentFindingSeverity`, `AgentEvaluationStatus`, `AgentAuthorityDomain`
- `AgentInvokerKind`, `AgentSubjectKind`, `AgentEvidenceRef`
- `ListGovernanceAgentsResponse`, `ListGovernanceFindingsResponse`,
  `ListGovernanceEvaluationsResponse`
- `ListGovernanceFindingsQuery`, `ListGovernanceEvaluationsQuery`
- `highestAgentFindingSeverity` — pure helper

Wire schema source of truth: `atlasent-api/packages/types/src/governance-agents.ts`.

### Testing

15 new tests in `test/governance-agents.test.ts`. `governanceAgents.ts`
module is at 100% line / branch / function coverage.

---

## @atlasent/sdk 2.5.0 (2026-05-20)

### New features

#### `withPermit` — lexically-scoped execution-boundary form

TypeScript mirror of the Python SDK's `atlasent.with_permit(...)`.
Same end-to-end contract as `protect` (evaluate + verifyPermit, fail
closed on anything other than `allow`), but binds the action body to
the permit's lifetime via a callback so the call site reads as
"execute this body under a permit":

```ts
import atlasent from "@atlasent/sdk";

const result = await atlasent.withPermit(
  {
    agent: "deploy-bot",
    action: "production.deploy",
    context: { commit, approver },
  },
  async (permit) => {
    return runDeploy(commit, { permitId: permit.permitId });
  },
);
```

The body is invoked exactly when `protect()` would return — never on
deny, hold, escalate, verification failure, or transport error. Errors
thrown inside the body propagate untouched; the permit has already
been consumed by the verify step in v1, so there is no compensating
revoke.

Pick the form that fits the call site:

- **`protect`** when the caller wants the verified `Permit` as a value
  — to pass it across a process boundary, persist it alongside their
  own record, or interleave it with non-trivial control flow.
- **`withPermit`** when the action body is a single lexical scope and
  "no permit, no execution" is the only thing the call site needs to
  express.
- **`requirePermit`** for dangerous operations described by a richer
  `ProtectedAction` descriptor (`resource_id`, `environment`).

All three resolve to the same wire contract and produce the same
audit-chain entry. Brings the TypeScript SDK to parity with the
Python SDK's canonical surface (Python ships `with_permit` since
2.4.0).

Exported as a named import and on the default export:

```ts
import { withPermit } from "@atlasent/sdk";
// or
import atlasent from "@atlasent/sdk";
await atlasent.withPermit(req, fn);
```

---

## @atlasent/sdk 2.0.0 (2026-05-18)

### New features

#### `evaluateMany` — batch evaluation (V2-D3)

One round-trip for up to 100 `evaluate` items via `POST /v1/evaluate/batch`.
Returns items in input order; per-item failures carry `errorCode`/`errorMessage`
rather than tearing down the whole batch.

```ts
import { evaluateMany } from "@atlasent/sdk/v2";

const result = await evaluateMany(transport, {
  items: [
    { action_type: "production.deploy", actor_id: "bot-1", context: {} },
    { action_type: "production.deploy", actor_id: "bot-2", context: {} },
  ],
});
for (const item of result.items) {
  console.log(item.index, item.decision); // "allow" | "deny" | ...
}
```

Throws `FeatureNotEnabledError` when the tenant `v2_batch` flag is off.

#### `authorizeStream` — SSE streaming authorization (V2-D4)

Streams `event: decision` frames for each item via `POST /v1/evaluate/stream`.
Per-item failures arrive as `event: error` frames without closing the stream.
Resolves with the terminal `event: complete` payload.

```ts
import { authorizeStream } from "@atlasent/sdk/v2";

const complete = await authorizeStream(
  transport,
  { items },
  {
    onDecision: (frame) => console.log(frame.index, frame.decision),
    onError:    (frame) => console.error(frame.index, frame.errorCode),
  },
);
console.log(`processed ${complete.count} items, partial=${complete.partial}`);
```

Throws `FeatureNotEnabledError` when the tenant `v2_streaming` flag is off.

#### `graphql` — read-only GraphQL endpoint (V2-D2 + V2-D8)

Bearer-authenticated `POST /v1/graphql`. Wave A schema exposes
`recentEvaluations(limit)` and `activeBundle`. Resolver errors surface
on `response.errors`; the SDK does not throw on them so callers can
inspect partial data.

```ts
import { graphql } from "@atlasent/sdk/v2";

const { data, errors } = await graphql(transport, {
  query: `{ recentEvaluations(limit: 10) { decisionId decision actorId } }`,
});
```

Throws `FeatureNotEnabledError` when the tenant `v2_graphql` flag is off.

#### `AtlaSentEscalateError` — new error class for escalate decisions

Distinct from `AtlaSentDeniedError`. An escalation signals that the policy
engine deferred the authorization decision to a human review queue — it is
not a hard denial. Middleware and agent orchestrators should catch this
specifically.

```ts
import { AtlaSentEscalateError } from "@atlasent/sdk";

try {
  await protect({ agent, action, context });
} catch (e) {
  if (e instanceof AtlaSentEscalateError) {
    await humanReviewQueue.submit({ userId: e.userId, requestId: e.requestId });
  } else if (e instanceof AtlaSentDeniedError) {
    throw new Error(`Denied: ${e.reason}`);
  }
}
```

### Breaking changes from 1.x

| Area | 1.x | 2.x |
|---|---|---|
| Wire request body | `{ action, agent, context, api_key }` | `{ action_type, actor_id, context }` — `api_key` removed from body; `Authorization: Bearer` header only |
| Wire response | `{ permitted, decision_id }` legacy fields | Canonical `{ decision, permit_token, request_id, expires_at, denial }` (legacy fields still parsed via `src/compat.ts` shims) |
| `verifyPermit` body | sends `context` field | `context` no longer sent (verify handler does not consult it) |
| Error on escalate | `AtlaSentDeniedError` with `decision: "escalate"` | `AtlaSentEscalateError` (distinct class, `instanceof AtlaSentError` still catches it) |
| `decision` field | `'ALLOW' \| 'DENY'` (2-value uppercase) | Deprecated in favour of `decision_canonical: 'allow' \| 'deny' \| 'hold' \| 'escalate'` |

The compat shims in `src/compat.ts` (`normalizeEvaluateRequest`,
`normalizeEvaluateResponse`) accept the 1.x `{ action, agent }` shape and
emit `console.warn`. Both shims are removed in v3.0.0.

### Migration guide (1.x → 2.x)

See [`docs/migration-2x.md`](../docs/migration-2x.md) for the full guide.
Quick summary:

```ts
// Before (1.x)
const result = await client.evaluate({ agent: "bot", action: "production.deploy", context });
if (!result.permitted) throw new Error(result.reason);

// After (2.x) — recommended
const result = await client.evaluate({ actorId: "bot", actionType: "production.deploy", context });
if (result.decision_canonical !== "allow") throw new Error(result.denial?.message);
```

---

## @atlasent/behavior 1.0.0 (2026-05-18)

First stable release of `@atlasent/behavior` — the BVS (Behavior Verification
System) integration layer. Graduates from `@atlasent/behavior-preview` which
is now deprecated.

### Functions

#### `getStateSummary(userId, clientOpts, opts?)`

Fetches a rolling event-count summary from the behavior-insights service.
Returns `StateSummary` with `event_count`, `category_counts`, and window
boundaries. Returns `null`-safe — callers should treat low-confidence
summaries as advisory only.

```ts
import { getStateSummary } from "@atlasent/behavior";

const summary = await getStateSummary("user-123", {
  baseUrl: process.env.BEHAVIOR_INSIGHTS_URL!,
  apiKey:  process.env.BEHAVIOR_API_KEY!,
});
console.log(summary?.event_count); // number of events in the window
```

#### `getCategoryAggregate(userId, category, clientOpts, opts?)`

Returns a `CategoryAggregate` for a specific `BehaviorCategory`
(`"behavior.health.mental"`, `"behavior.health.adherence"`,
`"behavior.financial"`, `"behavior.minor"`). Useful for fine-grained
policy context before calling `evaluate`.

```ts
import { getCategoryAggregate } from "@atlasent/behavior";

const agg = await getCategoryAggregate("user-123", "behavior.financial", clientOpts);
console.log(agg.count, agg.confidence_low);
```

#### `attachToEvaluate(userId, clientOpts)`

Convenience helper — fetches the behavior summary and returns a
`behavior_context` metadata object ready to merge into the AtlaSent
`evaluate` request context. Fails silently (returns `{}`) so a
behavior-insights outage never blocks an authorization call.

```ts
import { attachToEvaluate } from "@atlasent/behavior";
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: process.env.ATLASENT_API_KEY! });
const behaviorContext = await attachToEvaluate("user-123", behaviorClientOpts);

const result = await client.evaluate({
  actionType: "production.deploy",
  actorId:    "user-123",
  context:    { ...appContext, ...behaviorContext },
});
```

### Package details

- Peer dependency: `@atlasent/sdk@^2.0.0`
- Zero runtime dependencies beyond the peer
- ESM + CJS dual build via tsup
- `"private": false` — publishable to npm

### Migration from `@atlasent/behavior-preview`

`@atlasent/behavior-preview` is now deprecated. Replace imports:

```diff
- import { getStateSummary } from "@atlasent/behavior-preview";
+ import { getStateSummary } from "@atlasent/behavior";
```

All three functions (`getStateSummary`, `getCategoryAggregate`,
`attachToEvaluate`) have the same signatures as the preview.

---

## [unreleased] — 2026-05-18

### Platform-generation reframing (doc-only, no code change)

Mirrors the umbrella reframing in [`atlasent/CHANGELOG.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/CHANGELOG.md). Platform generations: **v1** = pilot + cash-flowing capability layer (this repo's V2_ROLLOUT.md is preserved with a normalization header and continues to apply); **v2** = full enterprise surface ([`atlasent/ENTERPRISE_V2_ROLLOUT.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/ENTERPRISE_V2_ROLLOUT.md)); **v3** = execution assurance. `V2-D#` identifiers retained; new decisions use `PROD-D#`. Package SemVer (e.g. `@atlasent/sdk@2.x`) is decoupled from platform generation labels per [`atlasent/VERSIONING_DOCTRINE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/VERSIONING_DOCTRINE.md) doctrine 1.

## [2.4.0] — 2026-05-17

### Added

- `EvaluateResponse`: `evaluationId`, `permit` (EvaluateResponsePermit), `permitToken`, `reasons[]`; `reason` and `permitId` marked `@deprecated`
- `ProofResponse` with `algorithm: "none" | "hmac-sha256"` and nullable `signature`
- `OverrideV1`, `CreateOverrideRequest`, `OverrideEvent`, `OverrideEventsResponse`, `OverrideListResponse`, `OverrideStatus`, `OverrideEventType`
- `HitlRespondRequest`, `HitlDetailResponse`, `HitlListResponse`; `HitlEscalation.metadata` field
- `GovernanceEvent`, `PermitV1` wire types

## [Unreleased]

### Changed
- `withPermit` now always sends `environment` in the verify request.
  Defaults to `"production"` with a console warning if not set on the
  evaluate payload. Set `context.environment` explicitly to suppress.
- `withPermit` now computes and sends `execution_hash` (SHA-256 of
  canonical evaluate payload) on permit consume. Required by the API
  for production permits as of 2026-05-14.

### Added

- **Contract test for ADR-0002 invariant I-6** — `test/policy-mutation-guard.test.ts`
  scans `AtlaSentClient.prototype` and fails CI if any method matches a
  governance-policy mutation shape. Test-only; no API surface change.
  See `atlasent-internal/architecture/ADR-0002` and atlasent-sdk#230.

## [2.3.1] — 2026-05-14

### Changed

- **Contract vectors regenerated against `production.deploy`** — the
  `contract/tools/gen_approval_artifact_vectors.mjs` generator was
  pinning `ACTION_TYPE = "deployment.production.deploy"`, which left
  every signed approval-artifact and approval-quorum fixture binding
  HMAC signatures and action_hash values to the legacy 3-part literal.
  Regenerated all 16 approval-artifact + 11 approval-quorum vectors
  with `ACTION_TYPE = "production.deploy"`; signatures, action_hash,
  and expected_action_hash all reflect the canonical wire identity.
  No verifier or schema changes — drift tests
  (`test/approval-artifact-vectors.test.ts`,
  `test/approval-quorum-vectors.test.ts`) continue to pass byte-for-byte
  against the in-memory generator output. Internal-only; no SDK API
  surface change.

## [2.3.0] — 2026-05-14

### Added

- **`PRODUCTION_DEPLOY_ACTION` constant** — exported from `@atlasent/sdk`
  (value `"production.deploy"`). The new V1 canonical Deploy Gate
  action string. Use this on new code; existing imports of
  `DEPLOYMENT_PRODUCTION_ACTION` continue to compile.

### Changed

- **`deployGate()` default action is now `"production.deploy"`** — the
  underlying server-side canonical was renamed in atlasent-api PR #662
  (`action_classes.slug`) and atlasent-console PR #432
  (`protected_actions.key`). The server alias-tolerates the legacy
  `"deployment.production"` during the V1 alias window, so callers
  that explicitly pin `action: "deployment.production"` continue to
  work; the SDK default just stops emitting the legacy literal.
- **Docs / examples / JSDocs updated** — README quickstart,
  `examples/deploy-gate.ts`, `examples/protect.ts`, and inline JSDoc
  snippets across `src/types.ts`, `src/client.ts`, `src/protect.ts`,
  `src/hono.ts`, and `src/index.ts` now show `"production.deploy"`.
- **`test/deploy-gate-v1.test.ts`** — the example-lock guard now
  enforces `production.deploy` and rejects `deployment.production`
  (previously inverted).

### Deprecated

- **`DEPLOYMENT_PRODUCTION_ACTION`** — still exported, value still
  `"deployment.production"`. Marked `@deprecated`; please migrate to
  `PRODUCTION_DEPLOY_ACTION`. Removal target: next minor release.

## [2.2.0] — 2026-05-07

### Added

- **Automatic retries with full-jitter backoff** — `AtlaSentClient` now
  retries transient failures (network errors, timeouts, HTTP 429 rate-limit,
  HTTP 5xx server errors, malformed JSON responses) using capped exponential
  backoff with full jitter (AWS-recommended scheme). Defaults: 3 total
  attempts, 250 ms base delay, 7 s ceiling. Customise or disable via the new
  `retryPolicy` constructor option:
  ```ts
  new AtlaSentClient({
    apiKey: "ask_live_…",
    retryPolicy: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 30_000 },
  });
  // Disable entirely:
  new AtlaSentClient({ apiKey: "ask_live_…", retryPolicy: { maxAttempts: 1 } });
  ```
  Non-retryable errors (`invalid_api_key`, `forbidden`, `bad_request`) are
  thrown immediately on the first attempt.
- `AtlaSentClientOptions.retryPolicy` — new optional field accepting a
  `RetryPolicy` object (`maxAttempts`, `baseDelayMs`, `maxDelayMs`).

### Fixed

- `SDK_VERSION` constant in the `User-Agent` header now correctly reflects
  the package version (`2.2.0`).
