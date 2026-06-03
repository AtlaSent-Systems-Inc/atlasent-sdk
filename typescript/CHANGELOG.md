# Changelog

All notable changes to `@atlasent/sdk` are documented here. The SDK
follows [semver](https://semver.org/): breaking changes bump the major
(or minor while on 0.x).

---

## @atlasent/sdk 2.13.0 (2026-06-03)

### New features

#### License verification — self-hosted / air-gapped deployments

Two new types and two new `AtlaSentClient` methods for the
`GET /v1/license` and `POST /v1/license/verify` endpoints added to
`atlasent-api` for self-hosted and air-gapped postures.

**New types** (`src/types.ts`):
- `LicenseStatus` — license validity state (`"active" | "grace" | "expired" | "revoked"`),
  `org_slug`, `posture`, `expires_at`, optional `grace_until`, `features` array,
  and optional `eval_limit` / `seat_limit` capacity limits.
- `LicenseVerifyResult` — `valid` flag plus optional `org_slug`, `expires_at`, and
  machine-readable `error` code.

**New client methods**:
- `client.getLicense()` — calls `GET /v1/license`; returns `LicenseStatus & { rateLimit }`.
- `client.verifyLicense(blob)` — calls `POST /v1/license/verify`; returns
  `LicenseVerifyResult & { rateLimit }`. A `valid: false` response is not thrown.

---

## @atlasent/sdk 2.12.0 (2026-05-28)

### New features

#### Trust-root V1 — vendor snapshot, background refresh, fail-closed expiry

`@atlasent/sdk` now ships a vendored trust-root snapshot and a background
refresh manager implementing ADR-005 D2/D3/D4.

**`TrustRootManager`** (`src/trustRoot.ts`):
- Loads `vendor/trust-root/` at startup; falls back gracefully if files
  are missing.
- Refreshes from `https://keys.atlasent.io/.well-known/` every 4 hours
  (floor: 5 min) via a non-blocking background timer.
- `getGlobalTrustRootManager()` — singleton accessor; idempotent across
  multiple imports.
- `checkExpiry()` — returns `"ok" | "half_life" | "expired"` and emits
  one-time `console.warn` at the half-life point and on expiry.

**Global auto-inject (B2.3):**
`verifyBundle()` automatically calls `getGlobalTrustRootManager().getSnapshot()`
when no explicit `trustRoot` option is passed.

**Fail-closed expiry (B2.4) — ⚠ breaking change:**
`verifyAuditBundle()` now **throws** `BundleVerificationError` when the
trust snapshot is expired instead of returning `{ verified: false }`.
Callers that branch on `result.verified === false` must migrate to:
```ts
try {
  await verifyAuditBundle(bundle, keys);
} catch (err) {
  if (err instanceof BundleVerificationError) { /* ... */ }
}
```
Pass `allowExpiredSnapshot: true` to disable fail-closed for air-gap
environments (emits one-time warning per process).

**Revocation enforcement (B2.5):**
- `BundleVerificationError(reason: "key_revoked")` — key in `revoked_keys`.
- `BundleVerificationError(reason: "key_role_mismatch")` — key role is not
  `R3_audit`.
- New `PermitOutcome` literal: `"permit_signing_key_revoked"`.
- `AtlaSentDeniedError.isSigningKeyRevoked` convenience getter.

**`BundleVerificationError`** extends `AtlaSentError` and carries:
`reason`, `snapshotValidUntil`, `snapshotFetchedAt`, `snapshotSource`, `kid`.

### Tests

- `test/trust-root-b31-smoke.test.ts` — 8 bootstrap smoke tests (vendor
  snapshot loads, dates parseable, ≥1 key, idempotent manager).
- `test/trust-root-b32-refresh.test.ts` — 6 refresh integration tests
  (mock fetch updates `valid_until`, keys, revoked_keys; silent on errors).

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

#### `Decision` — unified decision type alias (Phase 2)

`Decision = "allow" | "deny" | "hold" | "escalate"` is now exported from the
package root as a canonical type alias. Use it for typed `switch` statements and
function signatures that accept or return a decision value.

```typescript
import type { Decision } from "@atlasent/sdk";

function handleDecision(d: Decision) { ... }
```

#### `Permit.permitExpiresAt` — permit expiry surface (Phase 2)

`Permit` now carries an optional `permitExpiresAt: string | undefined` field
populated from the server's `expires_at` on `protect()` responses. Callers can
use this for proactive permit-refresh scheduling without polling `/v1/permits/:id`.

#### `EvaluateResult.reasons` — plural reasons array (Phase 2)

`EvaluateResult` now carries `reasons: string[]` alongside the existing singular
`reason` string. The array is populated directly from the wire `reasons` field;
when the server returns only a singular `reason` the SDK wraps it in a
one-element array for backward compatibility. New code should prefer `reasons`.

#### Retries with jitter (Phase 2)

The SDK's internal retry loop now uses **full-jitter exponential back-off** on
transient errors (5xx, network timeout, `ECONNRESET`). Previously the back-off
was a fixed delay. The jitter prevents thundering-herd retry storms in
high-concurrency deployments. Maximum retry count and base delay are unchanged;
no public API surface change.

#### Browser guard warning (Phase 2)

When the SDK detects it is running in a browser context (i.e. `window` is
defined and `process` is not), it now emits a `console.warn` advising that API
keys should not be used client-side. No error is thrown — the warning is
informational only and can be suppressed by passing `{ suppressBrowserWarning:
true }` in the client constructor options.

#### `verifyEvidenceBundle(bundle)` — offline evidence-bundle verifier (Phase 3)

A new top-level `verifyEvidenceBundle(bundle)` function verifies a compliance
evidence bundle dict offline without a backend round-trip:

```typescript
import { verifyEvidenceBundle } from "@atlasent/sdk";

const result = verifyEvidenceBundle(bundle);
if (!result.valid) {
  console.error(result.reason);
}
```

Checks:
1. Required top-level fields are present.
2. `bundle.status === "ready"`.
3. SHA-256 root hash integrity when `hash_chain` is present.

Returns `EvidenceVerificationResult: { valid: boolean; permitId?: string; bundleId?: string; reason?: string }`.

Both `verifyEvidenceBundle` and `EvidenceVerificationResult` are exported from
the package root.

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
