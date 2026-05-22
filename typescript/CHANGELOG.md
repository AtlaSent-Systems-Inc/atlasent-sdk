# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

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

## Unreleased

### Added (canonical REST migration for revoke / verify)

- `client.revokePermitById(permitId, { reason? })` — calls
  `POST /v1/permits/{permitId}/revoke`. Returns the full updated
  `PermitRecord` with `status === 'revoked'` and `revoked_at` /
  `revoked_by` / `revoke_reason` populated, instead of the legacy
  `{revoked, permitId}` envelope.
- `client.verifyPermitById(permitId)` — calls
  `POST /v1/permits/{permitId}/verify`. Returns the unified
  verification envelope (`valid`, `verification_type: 'permit'`,
  `reason`, `verified_at`, `evidence`) plus the full `PermitRecord`
  fields preserved at the top level. The `valid` field is the
  canonical contract.
- New types: `RevokePermitByIdInput`, `RevokePermitByIdResponse`,
  `VerifyPermitByIdResponse`.

### Deprecated

- `client.revokePermit(input)` and `RevokePermitResponse` —
  legacy `POST /v1-revoke-permit` (token-in-body). Migrate to
  `revokePermitById(permitId, options)`.
- `client.verifyPermit(input)` and `VerifyPermitResponse` —
  legacy `POST /v1-verify-permit` (token-in-body). Migrate to
  `verifyPermitById(permitId)`.

The legacy methods continue to work for the rest of the
`@atlasent/sdk@2.x` line. Removal lands in `@atlasent/sdk@3`.

### Notes

- No version bump. Wire contract is unchanged on either path.
- Wire shape on the canonical surface: `verify` returns the
  envelope + Permit row (allOf in openapi from atlasent-api#352);
  `revoke` returns the updated Permit row directly
  (atlasent-api#351).
- Tests: +7 (4 revokePermitById, 3 verifyPermitById).
  Full SDK suite 462/462 green.


### Added (decision casing canonicalization)

- **`decision_canonical`** field on `EvaluateResponse` and
  `StreamDecisionEvent` — carries the canonical 4-value lowercase
  decision byte-identical to the wire: `'allow' | 'deny' | 'hold' |
  'escalate'`. `hold` and `escalate` are preserved as distinct
  states and not collapsed.
- New exported type `DecisionCanonical = 'allow' | 'deny' | 'hold' | 'escalate'`.

### Deprecated

- `decision: 'ALLOW' | 'DENY'` on `EvaluateResponse` and
  `StreamDecisionEvent`. The 2-value field collapses `hold` and
  `escalate` into `'DENY'`, hiding distinct authorization states.
  **Use `decision_canonical` instead.** Will be removed/changed in
  `@atlasent/sdk@3`.
- Existing `Decision = 'ALLOW' | 'DENY'` type retains its current
  shape; `@deprecated` JSDoc points callers at `DecisionCanonical`.

### Notes

- No version bump (`@atlasent/sdk@2.x` line). Wire contract is
  unchanged. Callers continue to work; new code should pin to
  `decision_canonical`.
- 4 new tests cover all four canonical values
  (`allow`/`deny`/`hold`/`escalate`) on `evaluate()` and verify the
  legacy `decision` correctly collapses non-allow values to `DENY`
  while `decision_canonical` preserves them.


### Added

- `client.getPermit(permitId)` — calls the canonical
  `GET /v1/permits/{permitId}` REST endpoint and returns the full
  Permit lifecycle state (status, all timestamps, `revoked_at` /
  `revoked_by` / `revoke_reason`, bound `payload_hash` /
  `decision_id`).
- `client.listPermits({status?, actorId?, actionType?, from?, to?, limit?, cursor?})`
  — calls `GET /v1/permits` with cursor pagination.
- New types exported from `@atlasent/sdk`: `PermitRecord`,
  `PermitStatus`, `ListPermitsRequest`, `ListPermitsResponse`,
  `GetPermitResponse`.

### Notes

- The existing `Permit` type (re-exported from `protect.ts`) is a
  smaller convenience shape used by `protect()`; it is unaffected.
  The new wire-shape type is exposed under the deliberately distinct
  name `PermitRecord` to avoid colliding with it.
- No SDK-version bump: types and methods are additive; `verifyPermit`
  and `revokePermit` continue to call their existing (legacy)
  endpoints. Migrating those to the canonical REST surface is a
  separate follow-on with a deprecation cycle.

## 2.0.0 — 2026-04-30 — wire-format reconciliation (BREAKING)

Wire-format reconciliation with the canonical shape in `atlasent-api/handler.ts`.
The public TS SDK surface (`AtlaSentClient.evaluate`, `AtlaSentClient.verifyPermit`)
is unchanged for callers using the documented method signature. The dual-shape
bridges in `src/compat.ts` (`normalizeEvaluateRequest`, `normalizeEvaluateResponse`)
transparently accept the legacy `{ action, agent }` request shape and the legacy
`{ permitted, decision_id }` response shape, emitting `console.warn` on legacy
request-field usage. Both shims will be removed in v3.0.0.

### Wire format

- `POST /v1-evaluate` body: `{ action_type, actor_id, context }`
  (was `{ action, agent, context, api_key }`).
- `POST /v1-verify-permit` body: `{ permit_token, action_type,
  actor_id }` (was `{ decision_id, action, agent, context,
  api_key }`).
- `api_key` is no longer echoed in the request body — server reads
  the `Authorization: Bearer ...` header (always sent).
- `context` is no longer sent on `verifyPermit` — the deployed
  verify handler does not consult it.

### Backward-compat

- The public TS API (`evaluate({ agent, action, context })`,
  `verifyPermit({ permitId, action, agent, context })`) is
  unchanged. The internal wire translation is what moved.
- Server responses are parsed in both shapes: canonical
  `{ decision, permit_token, request_id, expires_at, denial }` and
  legacy `{ permitted, decision_id, reason, audit_hash, timestamp }`.
  A SDK upgrade ahead of an atlasent-api upgrade still parses the
  old wire response cleanly.

### Wire interfaces (`EvaluateWire`, `VerifyPermitWire`)

Internal types now expose the canonical shape with legacy fields as
optional passthrough so unit tests asserting on either shape
continue to pass.

### Coupled change — atlasent-api

This release expects `atlasent-api/.../v1-evaluate/index.ts` to
delegate to `handler.ts` (atlasent-api PR for #190). Older
deployments serving the slim `index.ts` will return
`400 BAD_REQUEST: missing 'action_type'` when called with the new
wire. Coordinate the SDK upgrade with the atlasent-api deploy.

## 1.6.0 — 2026-04-30

### Added

- **`AtlaSentDeniedError.outcome`** — discriminator that distinguishes
  permit-side denial reasons (D4 of `LAST_20_EXECUTION_PLAN`).
  Populated from `/v1-verify-permit` `outcome`. Typed as
  `PermitOutcome` (`"permit_consumed" | "permit_expired" |
  "permit_revoked" | "permit_not_found"`). Predicates `isRevoked`,
  `isExpired`, `isConsumed`, `isNotFound` map directly to the
  operator runbook matrix in
  `atlasent/docs/REVOCATION_RUNBOOK.md`.

  Pre-existing callers are unaffected — `outcome` defaults to
  `undefined` and existing init fields are unchanged. The error
  message and `reason` field still carry the raw outcome string for
  log debuggability.

  Unknown / future outcome strings normalize to `undefined` (rather
  than surfacing an unrecognized literal), so callers branching on
  `err.outcome` won't accidentally match an outcome string the SDK
  was built before.

  ```ts
  import atlasent, { AtlaSentDeniedError } from "@atlasent/sdk";

  try {
    await atlasent.protect({ agent: "bot", action: "deploy" });
  } catch (err) {
    if (err instanceof AtlaSentDeniedError) {
      if (err.isRevoked) notifySecurity("permit revoked mid-flight");
      else if (err.isExpired) await retryAfterRefresh();
      else throw err;
    }
  }
  ```

  Mirrors the Python SDK's `PermitOutcome` (atlasent-sdk PR #132).

### Migration notice — `@atlasent/sdk/hono` API will change after Enforce GA

The `atlaSentGuard` middleware currently calls `protect()` directly.
`protect()` wraps `evaluate` but does **not** enforce the full
`evaluate → verifyPermit → execute` chain as a non-bypassable
invariant. Once `@atlasent/enforce` reaches GA, the guard will be
rebuilt so the route handler becomes the `execute` callback inside
`Enforce.run()`, closing that gap.

**Current API (stable until Enforce GA):**

```ts
import { atlaSentGuard, atlaSentErrorHandler } from "@atlasent/sdk/hono";

app.post(
  "/deploy",
  atlaSentGuard({
    action: "deployment.production",
    agent: (c) => c.req.header("x-agent-id") ?? "anonymous",
    context: async (c) => ({ commit: (await c.req.json()).commit }),
  }),
  (c) => {
    const permit = c.get("atlasent");   // type: Permit
    return c.json({ ok: true, permitId: permit.permitId });
  },
);
app.onError(atlaSentErrorHandler());
```

**Future API (post Enforce GA):**

```ts
import { Enforce } from "@atlasent/enforce";
import { atlaSentGuard, atlaSentErrorHandler } from "@atlasent/sdk/hono";

const enforce = new Enforce({
  client,
  bindings: { actorId: (c) => c.get("userId"), actionType: "deployment.production" },
  failClosed: true,
});

app.post(
  "/deploy",
  atlaSentGuard({ enforce }),           // enforce instance injected
  (c) => {
    const permit = c.get("atlasent");   // type: VerifiedPermit (was: Permit)
    return c.json({ ok: true, permitId: permit.token });
  },
);
app.onError(atlaSentErrorHandler());
```

Key differences:

| | Current | Post Enforce GA |
|---|---|---|
| Guard config | `action`, `agent`, `context` per-route | `enforce` instance (owns bindings) |
| Context value | `Permit` (v1) | `VerifiedPermit` |
| Bypass possible? | Yes — `protect()` can skip `verifyPermit` | No — `Enforce.run()` enforces the chain |

The existing `action/agent/context` API is **not deprecated** until
the migrated guard ships. This notice is informational. See
[`contract/ENFORCE_PACK.md`](../contract/ENFORCE_PACK.md) for the
complete migration plan and gating criteria.

## 1.6.0 — 2026-04-30

### Fixed

- **Browser compatibility: `process.version` reference removed.**
  The `User-Agent` header in every outbound request was constructed as
  `` `@atlasent/sdk/${SDK_VERSION} node/${process.version}` ``.
  In a browser, `process` is `undefined` → `ReferenceError` on the
  very first call. The client now detects the runtime at module-load
  time via `typeof process !== "undefined" && typeof process.versions?.node === "string"`
  and emits one of two shapes:

      // Node / server runtimes
      User-Agent: @atlasent/sdk/1.6.0 node/20.11.0

      // Browser / jsdom / Cloudflare Workers
      User-Agent: @atlasent/sdk/1.6.0 browser

  Browsers strip `User-Agent` from `fetch` requests (it is a [forbidden
  header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name));
  the browser-shaped header is therefore sent into the void harmlessly.

- **Browser compatibility: `AbortSignal.timeout` guard.**
  The SDK's per-request timeout relies on `AbortSignal.timeout(n)`,
  available in Chrome 103+, Firefox 100+, and Safari 16+. On older
  runtimes the previous code would silently create a request with no
  timeout at all. The constructor now throws an `AtlaSentError` with
  `code: "network"` and a human-readable message that names the
  minimum browser versions, so the failure is loud and actionable
  rather than silent.

### Added

- **`browserslist` field in `package.json`** — declares the minimum
  supported browser targets (Chrome ≥ 103, Firefox ≥ 100, Safari ≥ 16,
  Edge ≥ 103). Bundlers that respect `browserslist` (Vite, webpack,
  Parcel) will use these targets for transpilation and polyfill
  decisions automatically.

- **Browser test suite** (`test/browser.test.ts`) — runs under
  `@vitest-environment jsdom` with `process` stubbed to `undefined`.
  Covers: construction, `evaluate()` ALLOW/DENY round-trip, browser-shaped
  `User-Agent` header, `Authorization` / `X-Request-ID` headers, HTTP 401
  error mapping, network-failure mapping, and the `AbortSignal.timeout`
  absence error. All without touching `process`, `Buffer`, or other
  Node-only globals.

- **Browser support section in `README.md`** — documents minimum browser
  versions, the `process.version` fix, the `AbortSignal.timeout` guard,
  and the two recommended auth models for browser-facing deployments
  (browser-scoped keys for internal dashboards; session-token mode for
  atlasent-hosted surfaces).

### Non-breaking

This release is purely additive / bug-fix. The Node-side API surface
(`AtlaSentClient`, `evaluate`, `verifyPermit`, `protect`, error
classes, types) is unchanged. Server-side consumers see no difference.

Closes [#103](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk/issues/103).

## 1.5.1 — 2026-04-29

### Fixed

- **Browser runtime compatibility** (closes #103). `User-Agent` was
  constructed with `process.version`, a Node-only global that throws a
  `ReferenceError` in browser environments. The header now uses runtime
  detection: `@atlasent/sdk/<version> node/<nodeVersion>` in Node,
  `@atlasent/sdk/<version> browser` everywhere else. Browsers strip
  `User-Agent` from `fetch` requests anyway (it is a
  [forbidden header](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)),
  so the value is informational only.

- **`SDK_VERSION` constant** corrected from `"0.1.0"` to track the
  actual package version.

### Added

- `browserslist` pinned to Chrome ≥ 103, Firefox ≥ 100, Safari ≥ 16
  — the floor required by `AbortSignal.timeout` and
  `crypto.randomUUID()`. Versions below this floor will fail loudly on
  the first request.

- **jsdom browser test** (`test/browser-compat.test.ts`): stubs
  `process` to `undefined` and verifies that `AtlaSentClient`
  constructs and round-trips an `evaluate()` call in a simulated
  browser environment without touching any Node globals.

## 1.5.0 — 2026-04-25

### Added

- **`AtlaSentClient.listAuditEvents()` and `createAuditExport()`.**
  Two new client methods close the long-standing `/v1-audit` parity
  gap. Together with the offline verifier (also new in this release)
  and the shared wire types added here, a customer can now go from
  "I have an API key" to "I have a signed, offline-verifiable bundle
  of my org's audit events" without leaving the SDK:

      const page = await client.listAuditEvents({
        types: "evaluate.allow,policy.updated",
        limit: 100,
      });
      // → { events: AuditEvent[], total, next_cursor?, rateLimit }

      const bundle = await client.createAuditExport({
        from: "2026-04-01T00:00:00Z",
        to: "2026-04-30T23:59:59Z",
      });
      // → signed bundle; hand straight to verifyAuditBundle(bundle, keys)

  Both methods return `*Result` types that extend the pure wire shape
  with a camelCase `rateLimit` field so rate-limit state surfaces
  consistently with `evaluate()` / `verifyPermit()`. The signed
  envelope fields (`export_id`, `org_id`, `chain_head_hash`,
  `event_count`, `signed_at`, `events`, `signature`) are preserved
  byte-for-byte, so `createAuditExport`'s return value drops straight
  into the offline verifier.

  `AuditEventsResult` and `AuditExportRequest` are exported alongside
  `AuditExportResult` for downstream typing.

- **Shared audit wire types.** `AuditEvent`, `AuditEventsPage`,
  `AuditEventsQuery`, and `AuditExport` are now exported from
  `@atlasent/sdk`, sourced from the `/v1/audit/*` wire contract served
  by the `v1-audit` edge function. Consumers that previously
  hand-rolled these shapes (or imported from an internal package) can
  now import them directly:

      import type {
        AuditEvent,
        AuditEventsPage,
        AuditEventsQuery,
        AuditExport,
      } from "@atlasent/sdk";

  Companion `AuditDecision` and `AuditExportSignatureStatus` unions
  are exported for completeness. Type-level sync assertions
  (`test/audit-types.test.ts`) lock the field set against the server
  docstring so wire drift fails CI.

- **Offline audit-bundle verifier.** `verifyBundle(path, { publicKeysPem })`
  and the lower-level `verifyAuditBundle(bundle, keys)` produce a
  byte-faithful port of `atlasent-api/supabase/functions/v1-audit/verify.ts`.
  Verifies a signed export from `POST /v1/audit/exports` end-to-end:
  per-event SHA-256 hash chain, adjacency, `chain_head_hash` match,
  and Ed25519 signature. Rotation-aware via `signing_key_id`. Runs on
  Node 20+ using `crypto.webcrypto.subtle`; no extra deps. Canonical
  JSON (`canonicalJSON`) and `signedBytesFor` are exported for
  regulator-side custom verifiers.
- Shared test fixtures at `contract/vectors/audit-bundles/` and
  reproducible generator at `contract/tools/gen_audit_bundles.py`.

### Non-breaking

This release is purely additive — existing exports are unchanged.

## 1.4.0 — 2026-04-23

### Added

- **`AtlaSentClient.keySelf()` — API-key self-introspection.** Calls
  `GET /v1/api-key-self` and returns the server's description of the
  key this client was constructed with:

      const info = await client.keySelf();
      // → { keyId, organizationId, environment, scopes, allowedCidrs,
      //     rateLimitPerMinute, clientIp, expiresAt, rateLimit }

  Never includes the raw key or its hash — introspection is
  intentionally read-only and safe to surface in operator dashboards.
  Useful for:
    - `IP_NOT_ALLOWED` debugging — `clientIp` is the IP the server
      observed (X-Forwarded-For first hop), so you can see exactly
      what the allowlist is being checked against.
    - Proactive expiry warnings — `expiresAt` is the server-stored
      expiry (`null` means the key does not auto-expire).
    - Verifying scopes before attempting a scope-gated action.
    - "Which key am I?" in multi-tenant dashboards that juggle more
      than one key.

  Response also includes `rateLimit` (the same `RateLimitState`
  surfaced on `evaluate`/`verifyPermit`), so key-introspection
  doubles as a cheap rate-limit probe without burning a permit.

- `ApiKeySelfResponse` type exported from the public entry point.

### Non-breaking

Adding `keySelf()` is purely additive — existing `evaluate` /
`verifyPermit` / `protect` APIs are unchanged.

## 1.3.0 — 2026-04-23

### Added

- **`rateLimit` field on every authed response.** The AtlaSent edge
  functions now emit `X-RateLimit-Limit`, `X-RateLimit-Remaining`,
  and `X-RateLimit-Reset` headers on success responses (the 429 path
  with `Retry-After` was already handled). The client parses the
  header triple and surfaces it as a typed `RateLimitState`
  (`{ limit, remaining, resetAt: Date }`) on both
  `EvaluateResponse.rateLimit` and `VerifyPermitResponse.rateLimit`.
  Consumers can preemptively back off instead of waiting for a 429:

      const result = await client.evaluate({ ... });
      if (result.rateLimit && result.rateLimit.remaining < 10) {
        await sleepUntil(result.rateLimit.resetAt);
      }

  `X-RateLimit-Reset` is accepted as either unix-seconds (the
  current server convention) or ISO 8601. `rateLimit` is `null`
  when any of the three headers is missing or unparseable — covers
  older server deployments and internal endpoints that skip
  per-key limits.

- `RateLimitState` type exported from the public entry point for
  consumers building their own back-off logic.

### Non-breaking

Adding `rateLimit: RateLimitState | null` to the response interfaces
is additive. Existing consumers that destructure `{ decision,
permitId, ... }` keep working unchanged. No wire-format change — the
headers have been emitted by the server but previously ignored by
the SDK.

## 1.2.0 — 2026-04-23

### Added

- **`@atlasent/sdk/hono` subpath export — Hono middleware.** Drop-in
  execution-time authorization for any Hono route:

      import { Hono } from "hono";
      import { atlaSentGuard, atlaSentErrorHandler } from "@atlasent/sdk/hono";

      const app = new Hono();
      app.onError(atlaSentErrorHandler());

      app.post(
        "/deploy/:service",
        atlaSentGuard({
          action: (c) => `deploy_${c.req.param("service")}`,
          agent: (c) => c.req.header("x-agent-id") ?? "anonymous",
          context: async (c) => ({ commit: (await c.req.json()).commit }),
        }),
        (c) => c.json({ ok: true, permit: c.get("atlasent") }),
      );

  The guard calls `atlasent.protect()` under the hood — same fail-closed
  semantics. On allow, it stashes the verified `Permit` on the Hono
  context (default key `"atlasent"`, override via `options.key`). On
  deny or transport error it **throws** so you can handle all
  AtlaSent failures in one place via `app.onError`.

- **`atlaSentErrorHandler(options?)` — one-call error mapping.** Maps
  `AtlaSentDeniedError` → 403 and `AtlaSentError` → 503 by default,
  with JSON bodies carrying `decision`, `evaluationId`, `reason`,
  `code`, and `requestId` as appropriate. Customise via `denyStatus`,
  `errorStatus`, `renderDeny`, `renderError`. Non-AtlaSent errors
  re-throw so other `onError` chains still see them.

- **Example**: `examples/hono-guard.ts` — end-to-end `POST /deploy/:service`
  route with the guard and error handler wired up.

### Changed

- `hono` added as an **optional** peer dependency (`^4.0.0`). Users
  who only import the default entry point (`@atlasent/sdk`) don't
  pull it in; users who import `@atlasent/sdk/hono` need `hono`
  installed alongside. Marked optional via `peerDependenciesMeta` so
  package managers don't warn when it's absent.

- `tsup` now builds two entry points (`index`, `hono`) into
  `dist/index.{js,cjs}` + `dist/hono.{js,cjs}` with matching
  `.d.ts` / `.d.cts`. `package.json` `exports` map updated.

### Notes

- Additive. No change to the default-export surface (`atlasent.protect`,
  `atlasent.configure`, `AtlaSentClient`, `AtlaSentError`,
  `AtlaSentDeniedError`). The Hono module re-exports `Permit`,
  `ProtectRequest`, `AtlaSentError`, and `AtlaSentDeniedError` so
  `@atlasent/sdk/hono` is self-contained for callers who only want
  the middleware.
- 9 new tests in `test/hono.test.ts` exercising a real Hono app
  against a mock `fetch`: allow path, function resolvers for
  agent/action/context, deny-throws, custom `key`, skipped
  downstream handler on deny, 403/503 default status mapping,
  custom status + render overrides, and non-AtlaSent error
  re-throw. 63/63 TS tests pass; tsup build + typecheck clean.

## 1.1.0 — 2026-04-22

### Added

- **`atlasent.protect(...)` — the one-call authorization primitive.**
  Fail-closed by construction: on allow, returns a verified `Permit`;
  on deny (or verification failure, transport error, auth error,
  rate limit), throws. There is no `{ permitted: false }` branch to
  forget.

      import atlasent from "@atlasent/sdk";

      const permit = await atlasent.protect({
        agent: "deploy-bot",
        action: "deployment.production",
        context: { commit, approver },
      });
      // …execute the action. If we got here, AtlaSent authorized it.

  Internally does `evaluate` → `verifyPermit` in a single call. The
  returned `Permit` carries `permitId`, `permitHash`, `auditHash`,
  `reason`, and `timestamp` so callers can log a full audit trail.

- **Default export** (`import atlasent from "@atlasent/sdk"`) exposing
  `protect`, `configure`, `AtlaSentClient`, `AtlaSentError`, and
  `AtlaSentDeniedError` on a single namespace object — Stripe /
  Auth0 / Supabase style. Named exports remain available for
  advanced callers (`import { AtlaSentClient } from "@atlasent/sdk"`).

- **`atlasent.configure({ apiKey?, baseUrl?, timeoutMs?, fetch? })`.**
  Configures the lazy process-wide client used by `protect`. Optional —
  `protect` also reads `ATLASENT_API_KEY` from the environment.
  Calling `configure` a second time replaces the singleton.

- **`AtlaSentDeniedError`** — dedicated subclass of `AtlaSentError`
  thrown exclusively by `protect` on denial. Carries:
  - `decision: "deny" | "hold" | "escalate"` (forward-compatible
    union; only `"deny"` is emitted against today's API)
  - `evaluationId: string` — the permit / decision id
  - `reason?: string` — policy engine's human-readable explanation
  - `auditHash?: string` — hash-chained audit-trail entry
  - `requestId?: string` — inherited from `AtlaSentError`

  `instanceof AtlaSentError` still catches denials (one exception
  family); use `instanceof AtlaSentDeniedError` to distinguish a
  policy decision from a transport/auth error.

- **`examples/protect.ts`** — canonical quickstart for the new
  primitive.

### Notes

- Additive. No existing export renamed or removed. `AtlaSentClient`,
  the two-method API (`evaluate` / `verifyPermit`), and the
  lowercase/uppercase `EvaluateResponse.decision` contract are all
  unchanged. Existing named-import callers keep working without any
  code change.
- `AtlaSentError.name` is no longer a `readonly` literal — it's a
  mutable string so the new subclass can override it to
  `"AtlaSentDeniedError"`. This is source-compatible for every
  practical use of the property (reading the string).

## 1.0.0 — 2026-04-17

First stable release. Exports one `AtlaSentClient` with two methods
and one flat `AtlaSentError`.

### Added

- `AtlaSentClient.evaluate({ agent, action, context? })` — policy
  decision. Returns `{ decision: "allow" | "deny", permitId, reason,
  auditHash, timestamp }`. A clean `DENY` is **not** thrown.
- `AtlaSentClient.verifyPermit({ permitId, agent?, action?, context? })`
  — verify a previously-issued permit end-to-end.
- `AtlaSentError` with flat `{ status, code, requestId, retryAfterMs }`.
  `code` is one of `invalid_api_key | forbidden | rate_limited |
  timeout | network | bad_response | bad_request | server_error`.
- Native `fetch`, `AbortSignal.timeout`, `crypto.randomUUID` — zero
  runtime dependencies. Requires Node 20+.
- Standard headers on every request: `Authorization: Bearer <key>`,
  `Accept`, `Content-Type`, `User-Agent`, and a fresh per-request
  `X-Request-ID` for log correlation.
- Wire format: `POST /v1-evaluate` and `POST /v1-verify-permit`. Both
  share the JSON shape in `contract/schemas/`; drift is enforced in
  CI by `contract/tools/drift.py`.

### Tests

- 39 tests across `test/client.test.ts` (20), `test/errors.test.ts`
  (4), and `test/contract-vectors.test.ts` (15). The contract-vector
  suite replays the same golden wire inputs used by the Python SDK,
  guaranteeing cross-language parity.
