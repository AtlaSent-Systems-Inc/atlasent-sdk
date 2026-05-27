# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

---

## @atlasent/sdk 2.11.0 (2026-05-27)

### New features

#### `client.auth` — multi-IdP token management sub-client

`AtlaSentClient` now exposes a `client.auth` sub-client for programmatic token
lifecycle management:

- `client.auth.refresh(refreshToken)` — refresh against the default IdP
  (`POST /v1/auth/token/refresh`). Returns `{ accessToken, refreshToken, tokenType, expiresIn }`.
- `client.auth.refreshWithIdp(idpId, refreshToken)` — refresh against a named
  SSO connection (`POST /v1/auth/idp/{idpId}/token/refresh`).
- `client.auth.listIdpConnections()` — list available IdP connections for the
  org (`GET /v1/auth/idp-connections`). Returns `{ id, name, provider, enabled, isDefault, createdAt, domains? }[]`.

#### `client.scim` — SCIM 2.0 provisioning sub-client

`AtlaSentClient` now exposes a `client.scim` sub-client for managing
SCIM-provisioned users and groups:

- `client.scim.users.list(orgId, { filter?, startIndex?, count? })`
- `client.scim.users.create(orgId, user)` — `schemas` injected automatically
- `client.scim.users.update(orgId, userId, user)` — full PUT replacement
- `client.scim.users.delete(orgId, userId)`
- `client.scim.groups.list(orgId, { filter?, startIndex?, count? })`
- `client.scim.groups.create(orgId, group)`
- `client.scim.groups.delete(orgId, groupId)`

#### `client.evidenceBundles` — compliance evidence bundle sub-client

- `client.evidenceBundles.create(orgId, { incidentId?, includedPermits?, includeOverrides? })`
- `client.evidenceBundles.get(orgId, bundleId)`
- `client.evidenceBundles.download(orgId, bundleId, { format? })` — returns `ArrayBuffer`

## Unreleased

### Packaging

- Normalized framework package licensing artifacts before publish:
  - `@atlasent/langchain`, `@atlasent/llamaindex`, and `@atlasent/cursor`
    now declare `"license": "Apache-2.0"` in `package.json`.
  - Package `LICENSE` files were normalized to Apache-2.0 text.
  - README license sections were updated to Apache-2.0.

## @atlasent/sdk 2.9.0 (2026-05-25)

### New features

#### `AtlaSentDeniedError.outcome` — permit-side denial discriminator (D4)

`AtlaSentDeniedError` now carries an `outcome` field typed as
`PermitOutcome | undefined`. When `/v1-verify-permit` rejects a permit,
the server's `outcome` string is normalized and surfaced here. Four
predicates provide ergonomic branching:

| Predicate | `outcome` value | When |
|---|---|---|
| `isRevoked` | `"permit_revoked"` | Operator revoked the permit mid-flight |
| `isExpired` | `"permit_expired"` | Permit TTL elapsed before verify |
| `isConsumed` | `"permit_consumed"` | Single-use permit already consumed |
| `isNotFound` | `"permit_not_found"` | Permit token not in DB |

Unknown future outcome strings normalize to `undefined` (forward-compat).
See `docs/REVOCATION_RUNBOOK.md` for the operator runbook.

```ts
try {
  await atlasent.protect({ agent, action, context });
} catch (err) {
  if (err instanceof AtlaSentDeniedError) {
    if (err.isRevoked) notifySecurity("permit revoked mid-flight");
    else if (err.isExpired) scheduleReauthorization();
  }
}
```

#### `protect()` / `protectWithEvidence()` — client-side `action` format validation

Both functions now validate that `action` matches the canonical
dot-notation format (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`) before
making any network call. Invalid values throw `AtlaSentError` with
`code: "bad_request"` immediately at call site, matching the 400
`invalid_action_type` the server would return. This surfaces
mis-configured callers at integration time rather than at runtime.

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

### Exports added

- `PermitOutcome` — `"permit_consumed" | "permit_expired" | "permit_revoked" | "permit_not_found"`
- `normalizePermitOutcome(raw)` — maps server strings to `PermitOutcome | undefined`

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
