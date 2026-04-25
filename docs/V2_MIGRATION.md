# Migrating from `atlasent` v1 → v2 — DRAFT

> **Status:** DRAFT v2 preview. Companion to
> [`docs/V2_PLAN.md`](./V2_PLAN.md) (in-flight on PR #57) and
> [`docs/V2_PILLAR9_PROOF_SYSTEM.md`](./V2_PILLAR9_PROOF_SYSTEM.md)
> (in-flight on PR #60). Surfaces described here are subject to
> change without semver discipline until v2 GA.
>
> This doc is the customer-facing migration narrative. If you're
> looking for the wire contract, start at
> `contract/schemas/v2/README.md`.

## TL;DR

**v2 is a non-breaking minor upgrade for callers of `protect()`.**
Existing code keeps working. Two new capabilities you can adopt
incrementally:

1. **Verifiable proofs** — wrap your callback in `protect()` and
   the SDK closes the loop with a signed Proof Object. Auditors can
   verify any past action offline without API access.
2. **Decision streaming + batch evaluate** — observability and
   throughput improvements for fleet operators.

Deprecation: `gate()` becomes a deprecation warning at v2.0,
removed at v3 (no earlier than 2027). Migrate to `protect()` —
already the recommended path in v1.

---

## What stays the same

- **Same API key** works for v1 and v2 — bring your existing
  `ask_live_...` key. Per-key rate limits unchanged.
- **`atlasent.protect({ agent, action, context })`** — the
  positional / keyword shape doesn't change. Old code compiles.
- **Error taxonomy** — `AtlaSentDenied`, `AtlaSentError`,
  `RateLimitError`, `ConfigurationError` keep their names and
  fields. Same fail-closed semantics: any failure to *confirm*
  authorization throws / raises; a clean policy DENY is data.
- **Audit chain** — the v1 hash-chain semantics persist. v2's
  proofs slot into the same chain, just with stronger client-side
  verifiability.
- **`X-RateLimit-*` headers** — same parsing, same `RateLimitState`
  surface on every authed response.

---

## What's new in v2

### 1. Pillar 9 — Verifiable Proof System

The category-defining v2 feature. `protect()` gains a callback
overload that closes the lifecycle with a signed Proof:

#### TypeScript (v2)

```typescript
import atlasent from "@atlasent/sdk";

const result = await atlasent.protect(
  {
    agent:   "deploy-bot",
    action:  "deploy_to_production",
    target:  "prod-cluster",
    payload: { commit, approver },     // hashed client-side; never sent
  },
  async ({ permit, proof }) => {
    return await performDeployment(permit);
  },
);
// result: { permit, proof, executionResult }
// result.proof is a signed envelope verifiable offline.
```

#### Python (v2)

```python
from atlasent import protect

result = await protect(
    agent="deploy-bot",
    action="deploy_to_production",
    target="prod-cluster",
    payload={"commit": commit, "approver": approver},
    callback=do_the_deploy,   # async fn taking (permit, proof) → result
)
# result.proof.signature verifies offline against the org's pinned key.
```

#### Lifecycle

```
hashPayload(payload)
    └─ POST /v1/evaluate (with payload_hash; raw payload never sent)
       └─ on ALLOW: POST /v1/permits/:id/verify
          └─ execute callback
             └─ on success: POST /v2/permits/:id/consume → signed Proof
             └─ on failure: POST /v2/permits/:id/consume (status: failed)
                            then re-throw original error
```

Five client-side checks the offline replay harness verifies on
any Proof bundle: `signature`, `chain_link`, `payload_hash`,
`policy_version`, `execution_coherence`. Same names + reason
codes online and offline.

#### What you do not need to change

- **Existing `protect()` calls without a callback continue to
  work** — they still produce a Permit, just no Proof. Migrate
  on your own schedule.
- **Existing audit-bundle verifiers continue to work** — the v1
  audit-bundle format is unchanged; v2 proofs are an additional
  surface, not a replacement.

#### What does change

- **Raw payload is no longer sent to the server.** `protect()`
  hashes it client-side via `canonicalizePayload()` + SHA-256.
  If your context contains data the server needs to see (e.g. for
  dynamic policy evaluation), put it in `context` not `payload`.
  Only `payload` is hashed; `context` flows through as-is.
- **A new mandatory step (consume)** runs after your callback.
  The SDK calls it automatically; budget +1 round trip per
  protected action. p99 latency target is unchanged.

### 2. Pillar 2 — Batch evaluate

```typescript
// TypeScript
const batch = await client.evaluateBatch([
  { action: "modify_record", agent: "agent-1", context: { id: "PT-001" } },
  { action: "modify_record", agent: "agent-1", context: { id: "PT-002" } },
  // ... up to 1000 items
]);
// batch.items[i].decision_id — independent permits, one rate-limit decrement
```

```python
# Python
batch = await client.evaluate_batch([
    EvaluateRequest(action="...", agent="...", context={...}),
    # ...
])
```

One HTTP call, one rate-limit decrement, one hash-chain entry
listing every contained `decision_id`. Order-preserved; failures
surface as tagged-union elements, not exceptions.

Opt into Pillar 9 proofs per-item by setting `payload_hash` on
the item — the response then carries `proof_id` and
`proof_status` for later `consume`.

### 3. Pillar 3 — Decision event subscription

Long-lived SSE stream for fleet observability:

```typescript
// TypeScript — EventSource-style
for await (const ev of client.subscribeDecisions({ since: lastSeen })) {
  if (ev.type === "consumed") {
    metrics.increment("atlasent.consume", { decision: ev.payload.execution_status });
  }
}
```

```python
# Python — async iterator over an httpx stream
async for ev in client.subscribe_decisions(since=last_seen):
    if isinstance(ev, ConsumedEvent):
        metrics.increment("atlasent.consume",
                          decision=ev.payload.execution_status)
```

Seven event types cover the full permit lifecycle:
`permit_issued`, `verified`, `consumed`, `revoked`, `escalated`,
`hold_resolved`, `rate_limit_state`. New types are additive —
SDKs forward unknowns as opaque so old clients keep consuming
events from new servers.

Resumable via `Last-Event-ID` (the SSE-standard header) using
the last-seen `event.id`.

### 4. Pillar 8 — Temporal adapter

Optional companion package for Temporal users — wraps each
Activity with `protect()`:

```typescript
// TypeScript
import { withAtlaSentActivity } from "@atlasent/temporal";

const protectedDeploy = withAtlaSentActivity(deployActivity, {
  action: "deploy_to_production",
  context: (input) => ({ commit: input.commit }),
});
```

```python
# Python
from atlasent_temporal import atlasent_activity

@atlasent_activity(
    action="deploy_to_production",
    context_builder=lambda input: {"commit": input["commit"]},
)
async def deploy(input):
    ...
```

Permit bound to `Context.current().info.workflowExecution.runId`
so every retry of an Activity within a Workflow shares the same
permit chain. Workflow signal `revokeAtlaSentPermits()` triggers
bulk revoke keyed on the run id.

---

## Deprecations

### `gate()` — deprecated at v2.0, removed at v3

`gate()` returns `(evaluation, verification)` separately;
`protect()` subsumes that with stronger guarantees and the new
proof flow. Migrating is mechanical:

```python
# v1 (still works in v2 with a deprecation warning)
result = client.gate("read_data", "agent-1", {"id": "x"})
if result.evaluation.decision and result.verification.valid:
    do_work()

# v2 (recommended)
permit = client.protect(agent="agent-1", action="read_data", context={"id": "x"})
do_work()
```

`AuthorizationResult` (the data-not-exception API) is **not**
deprecated — it stays as the explicit "I want a value, not an
exception" path.

---

## Compatibility matrix

| What you have | What you do | What changes |
|---|---|---|
| `protect()` no callback | Nothing. Code works as-is. | No proof emitted; no other observable change. |
| `evaluate()` + `verify()` | Nothing. The two-step path is preserved. | Available for advanced use; not deprecated. |
| `gate()` | Migrate to `protect()` before v3. | Deprecation warning at v2.0. |
| `authorize()` | Nothing. Data-not-exception path preserved. | No change. |
| Audit-bundle verifier (`verify_bundle` / `verifyBundle`) | Nothing. v1 bundles still verify. | Add proof-bundle verifier (`replay_proof_bundle` / `replayProofBundle`) for the new Proof surface. |

---

## Floor bumps

- **Node.js**: floor bumps from 18 → 20. v1 already ran on 20+;
  v2 makes it official so we can rely on native `EventSource` /
  `webcrypto.subtle.verify('Ed25519', ...)` without polyfills.
- **Python**: floor stays at 3.10. `httpx` floor bumps to ≥0.27
  for stream-reconnect semantics on the streaming client.
- **TypeScript types**: peer deps bump to `typescript ≥ 5.4`
  (matches v1.x already).

---

## Going to alpha early

Two preview packages are available for early-access
verification, **not** for production use:

- **TypeScript**: `@atlasent/sdk-v2-preview` —
  `canonicalizePayload`, `hashPayload`, `verifyProof`,
  `replayProofBundle`, `parseDecisionEventStream`, plus all v2
  types. No HTTP client (yet); compose with your own `fetch`.
- **Python**: `atlasent-v2-preview` — same surface, same
  parity invariants. `cryptography>=41.0.0` and
  `pydantic>=2.0.0` runtime deps.

Install alongside v1 (different package name); both can coexist
in the same project. Pin to the exact preview version — semver
does not apply until v2 GA.

---

## Pre-GA checklist for adopters

Before v2.0.0 lands you can de-risk the migration by:

1. ✅ Switching `protect()` calls that pass `payload` data to
   put pre-hash-able state in `payload` and free-form context in
   `context`.
2. ✅ Wiring the v1 audit-bundle verifier in your CI today —
   v2's proof verifier reuses the same `signing-keys` registry,
   so the trust set is portable.
3. ✅ Adding `proof_id` columns to your audit dashboards. The
   column starts NULL on v1; v2 backfills it as proofs are
   issued.
4. ✅ Subscribing to the deprecation channel (`#atlasent-sdk` Slack)
   — you'll get warnings about `gate()` removal at least one minor
   release before v3.

---

## Open questions tracked elsewhere

- **`@atlasent/types` v2 publishing path** — `contract/PROPOSALS/003`
  + planning on PR #57.
- **Streaming evaluate vs. decision-event union** — open question
  on PR #61 §4.
- **Temporal adapter distribution** (separate package vs. extra)
  — open question on PR #57.

---

## Feedback

This guide ships in v2-preview today so customers can read it
ahead of v2 GA. Issues and proposed edits go on the v2-prep
issue tracker; pre-GA changes happen via PRs against this file.

Do not merge before v2 GA. Customer-facing pre-GA wording will
need a marketing pass before publish.
