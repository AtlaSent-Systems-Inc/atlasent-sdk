# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

---

## @atlasent/sdk 2.8.0 (2026-05-24)

### New features

#### `client.replay()` — ADR-015 Phase C parity runtime

SDK-canonical replay method. Re-evaluates a prior decision against the
current policy bundle to surface drift. Returns a camelCase `ReplayResponse`
with a `varianceKind` that maps raw wire values to SDK-canonical names.

```ts
import { AtlaSentClient } from "@atlasent/sdk";

const client = new AtlaSentClient({ apiKey: "ask_live_..." });
const result = await client.replay({ evaluationId: "<uuid>" });

if (result.varianceKind !== "NONE") {
  console.warn("Policy drift detected:", result.varianceKind);
}
```

**Wire mapping** (server `variance` → SDK `varianceKind`):

| Wire value        | SDK `varianceKind` | Meaning                              |
|-------------------|--------------------|--------------------------------------|
| `NONE`            | `"NONE"`           | Exact match — no drift               |
| `DECISION_CHANGED`| `"POLICY_DRIFT"`   | Policy changed; outcome differs      |
| `ENVELOPE_DRIFT`  | `"ENVELOPE_DRIFT"` | Envelope hash mismatch               |
| `ENGINE_DRIFT`    | `"ENGINE_DRIFT"`   | Engine retired/unknown               |
| `CHAIN_TAMPER`    | `"CHAIN_TAMPER"`   | Audit chain tampered                 |
| `BUNDLE_MISSING`  | `"BUNDLE_MISSING"` | No policy bundle recorded            |
| 409 + "engine"    | `"ENGINE_DRIFT"`   | Engine retired (409 path)            |
| 409 + "bundle"    | `"BUNDLE_MISSING"` | Bundle missing (409 path)            |

**Never throws** on `409 replay_not_eligible` — returns
`acceptsReplay: false` with the appropriate `varianceKind`.

#### Updated type exports

- `ReplayVarianceKind` — expanded superset covering both `replayDecision()` wire values
  (`NONE`, `DECISION_CHANGED`, `ENVELOPE_DRIFT`) and `replay()` SDK values
  (`POLICY_DRIFT`, `ENGINE_DRIFT`, `CHAIN_TAMPER`, `BUNDLE_MISSING`)
- `ReplayRequest` — `{ evaluationId: string }` (from `./replay.js`)
- `ReplayResponse` — full camelCase response envelope (from `./replay.js`)

All three are re-exported from the package root (`"@atlasent/sdk"`).
`ReplayRequest` and `ReplayResponse` now live in `replay.ts` alongside
the `replayDecision()` wire types.

### Tests

9 new vitest cases in `typescript/test/client-replay.test.ts`:
- NONE variance (allow→allow)
- DECISION_CHANGED → POLICY_DRIFT
- ENVELOPE_DRIFT (no `replayedDecision`)
- 409 + engine message → ENGINE_DRIFT (no throw)
- 409 + bundle message → BUNDLE_MISSING (no throw)
- URL path construction (`/v1/decisions/:id/replay`)
- POST method assertion
- Rate-limit header parsing
- `decision_id` fallback to `evaluationId`

### Conformance vectors

5 vectors added to `contract/vectors/replay.json`:
`replay-none-allow`, `replay-policy-drift`, `replay-envelope-drift`,
`replay-engine-drift`, `replay-bundle-missing`.

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
`ReplayVarianceKind`, `EngineVersionKind`, `EnvelopeVerification`,
`EnvelopeDriftDetail`, `ReplayDecisionValue`.

> Note: `/v1/decisions/:id/replay` is **alpha** per atlasent-api's
> `STABLE_V2_PROMOTION.md`. Wire shapes can shift without a deprecation
> cycle until the endpoint graduates to stable v1.

---

## @atlasent/sdk 2.6.0 (2026-05-22)

### New features

#### Constrained governance agents — advisory read surface

Three new client methods that wrap the `v1-governance-agents` edge
function in atlasent-api, plus the wire types and a severity rollup
helper. **Read-only by design** — there is no invocation method on
the SDK. Agent invocation is a CI concern (atlasent-action's
`governance-agents` mode), not an application concern.
