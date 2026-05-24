# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

---

## @atlasent/sdk 2.9.0 (2026-05-24)

### New features

#### Risk envelope — Phase C

Every evaluate response from engine version `wire-v1@1.0.0+` now includes
a `riskEnvelope` field exposing the composite risk score and how the policy
engine decision interacts with the risk envelope:

```typescript
const result = await client.evaluate({ agent, action, explain: true });

if (result.riskEnvelope) {
  console.log(result.riskEnvelope.weightedScore);      // 0.723
  console.log(result.riskEnvelope.engineDecision);    // "allow"
  console.log(result.riskEnvelope.envelopeDecision);  // "hold"
  console.log(result.riskEnvelope.promoted);          // true
  console.log(result.riskEnvelope.hardBlocks);        // []
  console.log(result.riskEnvelope.factors);           // per-factor breakdown
}
```

New types: `EvaluateRiskEnvelope`, `EvaluateRiskEnvelopeFactor` (exported from the root).

`promoted: true` means the envelope raised the engine decision's severity via
most-restrictive-wins. The envelope structurally cannot soften a deny.

`factors` is only populated when `explain: true` is passed on the request (see below).

#### `explain` request flag

Pass `explain: true` on `EvaluateRequest` to receive a per-factor breakdown in
`riskEnvelope.factors`:

```typescript
const result = await client.evaluate({
  agent: "payment-agent",
  action: "approve_payment",
  explain: true,
});
// result.riskEnvelope.factors is now populated
```

Seven factors: `ACTION_SENSITIVITY`, `ACTOR_AUTHORITY`, `ORG_POLICY_STRICTNESS`,
`ENVIRONMENT`, `CONTEXT_ANOMALY`, `HISTORY`, `BEHAVIOR_BASELINE`.
Each carries `{ factor, value, weight, reason }`.

Omit `explain` (or pass `false`) to keep payloads small.

---

## @atlasent/sdk 2.8.0 (2026-05-24)

### New features

#### `client.replay()` — ADR-015 Phase C parity runtime

`replay({ evaluationId })` re-evaluates a recorded decision against its
originally-pinned policy bundle via `POST /v1/decisions/:id/replay`.
Returns SDK-canonical variance kinds — callers always `switch` on
`result.varianceKind` and never need to catch.

Key differences from `replayDecision()` (2.7.0):

| | `replayDecision()` | `replay()` |
|---|---|---|
| Path | `/v1-decisions-replay/:id/replay` | `/v1/decisions/:id/replay` |
| Variance kind | raw wire (`DECISION_CHANGED`) | SDK-canonical (`POLICY_DRIFT`) |
| 409 handling | throws `AtlaSentError` | returns `ENGINE_DRIFT` / `BUNDLE_MISSING` |
| Input shape | `decisionId: string` | `{ evaluationId: string }` |

Variance mapping: `DECISION_CHANGED` → `POLICY_DRIFT`; 409
`replay_not_eligible` → `ENGINE_DRIFT` or `BUNDLE_MISSING` (based on
message content).

New exports: `ReplayRequest`, `ReplayResponse` (from `./replay.js`).
`ReplayVarianceKind` is extended to the 7-value superset covering both
`replayDecision()` raw wire values and `replay()` canonical values.

---
## @atlasent/sdk 2.7.0 (2026-05-24)

### New features

#### Decision replay client

A new `client.replayDecision(decisionId)` method that wraps
`POST /v1-decisions-replay/:id/replay`. Re-evaluates a recorded
decision against its originally-pinned policy bundle and engine version,
and reports whether the result agrees with the recorded one. Side-effect
free — no audit chain row is written and no permit is issued (per
ADR-016). Useful for compliance review, regression testing of bundle
changes, and post-incident investigation.

Surface returns one of three `variance` outcomes:
- `NONE` — replay agrees with the original.
- `DECISION_CHANGED` — same envelope, same bundle, different decision
  (typically a rule non-determinism bug).
- `ENVELOPE_DRIFT` — recorded request envelope no longer hashes to the
  recorded value; replay short-circuits without re-evaluating.

Also exports the supporting wire types: `ReplayDecisionResponse`,
`ReplayVarianceKind`, `EngineVersionKind`, `EnvelopeDriftDetail`,
`EnvelopeVerification`, `ReplayDecisionValue`.

> Note: `/v1/decisions/:id/replay` is **alpha** per atlasent-api's
> `STABLE_V2_PROMOTION.md`. Wire shapes can shift without a deprecation
> cycle until the endpoint graduates to stable v1.

---

## @atlasent/sdk 2.6.0 (2026-05-22)
