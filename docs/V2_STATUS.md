# atlasent-sdk — v2 prep status

> **Status:** DRAFT v2 navigation aid. Updated as draft PRs land.
> Companion to:
> * `docs/V2_PLAN.md` (PR #57) — pillar-based plan
> * `V2_ROLLOUT.md` (PR #77) — capability-based plan
> * `docs/V2_PILLAR9_PROOF_SYSTEM.md` (PR #60) — Pillar 9 spec
> * `docs/V2_MIGRATION.md` (PR #78) — customer migration guide
>
> Do not merge before v2 GA. The pre-GA stack is meant to be
> reviewed PR-by-PR; this doc is the index.

## Overview

The v2 prep stack adds **eight workstreams** on top of v1 without
modifying any v1 surface:

| # | Workstream | TS | Python | Schemas | Tests |
|---|---|---|---|---|---|
| 1 | Pillar 2 — batch evaluate | ✅ builders + polyfill | ✅ builders + polyfill | ✅ | ✅ |
| 2 | Pillar 3 — decision-event stream | ✅ SSE parser | ✅ SSE parser | ✅ | ✅ |
| 3 | **Pillar 5 — analytics** | ❌ | ❌ | ❌ | ❌ |
| 4 | Pillar 8 — Temporal adapter | ✅ activity + workflow | ✅ activity + workflow | n/a | ✅ |
| 5 | Pillar 9 — verifiable proofs | ✅ types + replay + parity | ✅ types + replay | ✅ | ✅ |
| 6 | GraphQL client (PR #77) | ✅ | ✅ | n/a | ✅ |
| 7 | OTel adapter | ✅ | ✅ | n/a | ✅ |
| 8 | Sentry adapter | ✅ | ✅ | n/a | ✅ |

Pillar 5 is the only gap. Deferred until the analytics backend
design ships.

## PR map (28 PRs, no v1 changes)

```
main
 │
 ├── Schemas + contract                              ──┐
 │   ├── #61  contract(v2): wire schemas (Pillars 2/3/9)│
 │   ├── #66  └─ proof-bundle vectors                  │
 │   │       └── #88  └─ canonicalization vectors       │
 │   └── #69  └─ OpenAPI 3.1 doc                        │
 │                                                     │
 ├── TypeScript v2-preview                              │
 │   └── #62  canonicalize, hash, types                 │
 │       ├── #64  offline replay harness                │
 │       │   └── #67  fixtures consumer                 │
 │       │       └── #93  cross-language signing parity │  All
 │       ├── #70  SSE parser (Pillar 3)                 │  drafts
 │       ├── #81  Pillar 2 batch builders               │  marked
 │       │   └── #94  evaluateBatchPolyfilled           │  v2 GA;
 │       └── #84  GraphQL client (PR #77)               │  no v1
 │                                                     │  changes
 ├── Python v2-preview                                 │
 │   └── #63  canonicalize, hash, models                │
 │       ├── #65  offline replay harness                │
 │       │   └── #68  fixtures consumer                 │
 │       ├── #71  SSE parser                            │
 │       ├── #82  Pillar 2 batch builders               │
 │       │   └── #95  evaluate_batch_polyfilled         │
 │       └── #85  GraphQL client                        │
 │                                                     │
 ├── Pillar 8 — Temporal                                │
 │   ├── #79  TS activity wrapper                       │
 │   │   └── #89  TS workflow signal helpers            │
 │   └── #80  Python activity decorator                 │
 │       └── #90  Python workflow signal helpers        │
 │                                                     │
 ├── Observability adapters                             │
 │   ├── #86  OTel TS                                   │
 │   ├── #87  OTel Python                               │
 │   ├── #91  Sentry TS                                 │
 │   └── #92  Sentry Python                             │
 │                                                     │
 └── Docs                                               │
     └── #78  customer-facing migration guide          ──┘
```

## What each capability gives a customer **today**

### Pillar 2 — batch evaluate (#81 / #82 / #94 / #95)

Customers can use the v2 batch API **today**, against the v1 server,
via the polyfill. When v2 server ships, swap the import — call
sites unchanged.

```ts
// Today — works against v1:
import { evaluateBatchPolyfilled } from "@atlasent/sdk-v2-preview";
const batch = await evaluateBatchPolyfilled(client, items);

// At v2 GA — single line change:
const batch = await client.evaluateBatch(items);
```

Trade-offs documented in #94's PR body: N HTTP calls instead of
one, N rate-limit decrements instead of one. Pillar 9 `payload_hash`
opt-in is silently ignored until v2 server ships.

### Pillar 3 — decision-event stream (#70 / #71)

Pure SSE parser. Customers wire their own HTTP transport (any v2
streaming endpoint they expose, including custom ones) and feed
the byte stream to `parseDecisionEventStream()` /
`parse_decision_event_stream()`. Reconnect / `Last-Event-ID` is the
caller's job.

### Pillar 8 — Temporal adapter (#79 / #80 / #89 / #90)

Wrap any Temporal Activity with v1's `protect()` for audit-chain
binding to the workflow `runId`. Workflow-side `RevokeAtlaSentPermitsSignal`
is wired with a stub activity that throws `BulkRevokeNotImplementedError`
until v2's `POST /v2/permits:bulk-revoke` ships — customers can
override the activity reference today to wire their own per-permit
revoke loop.

### Pillar 9 — verifiable proofs (#62 / #63 / #64 / #65 / #66 / #67 / #68 / #88 / #93)

Most heavily covered workstream. What ships:

* Canonicalization (`canonicalizePayload` / `canonicalize_payload`) —
  byte-parity-tested against v1's audit-bundle canonicalizer, against
  shared on-disk vectors, and across languages via #93's signing-parity
  test (18 byte-equal Ed25519 signature assertions).
* Hashing (`hashPayload` / `hash_payload`) — SHA-256 over canonical JSON.
* Types — `Proof`, `ConsumeRequest`, `ConsumeResponse`,
  `ProofVerificationResult`, `ProofVerificationCheck`, plus 6 enums.
  Field-order tested against schema declaration order.
* Offline replay (`replayProofBundle` / `replay_proof_bundle`) —
  five checks per proof: `signature`, `chain_link`, `payload_hash`,
  `policy_version`, `execution_coherence`. Rotation-aware via
  `signing_key_id`.
* Shared vectors (#66) — 6 fixtures × 3 proofs covering valid,
  tampered-payload, broken-chain, pending, wrong-key, rotated-key
  paths. Plus 26 canonicalization vectors (#88).

What's missing: the actual `consume()` HTTP call (`POST /v2/permits/:id/consume`),
the online verifier (`POST /v2/proofs/:id/verify`). Both wait on
v2 server endpoints.

### GraphQL client (#84 / #85)

Pure GraphQL-over-HTTP. Hand-written per PR #77's default plan
("hand-written vs. SDL codegen" stays open for v2 GA). Native
`fetch` (TS) / `httpx.AsyncClient` (Python). Locked headers
(Authorization / Content-Type / Accept / User-Agent / X-Request-ID)
prevent accidental key leakage from caller-supplied `headers`.

GraphQL-level errors return in the response envelope; transport /
HTTP / parse failures throw `GraphQLClientError`.

### OTel + Sentry adapters (#86 / #87 / #91 / #92)

Wrap any v1 client with automatic span creation (OTel) and / or
breadcrumb emission (Sentry). Both stack — wrap with OTel first,
then Sentry. Both close PR #57's "Sentry / OpenTelemetry breadcrumbs"
ergonomics line.

`atlasent.error_code` + `atlasent.request_id` mirror v1's
`AtlaSentError` shape verbatim, so log / breadcrumb / span data
joins on the same keys across both adapters.

## Open contract questions (require API team)

Searchable across the PR bodies; collected here:

### Pillar 9

1. **Signed envelope membership.** Schema's 18-field declaration
   includes `signature` and `signing_key_id`, but they can't be
   inside the bytes they cover. Both SDK previews + the generator
   codify a 16-field signed subset (declaration order minus
   signature + signing_key_id). Confirm before v2 GA. *Tracked on #61.*
2. **Raw payload vs. pre-hashed payload on `/consume`.** Recommend:
   server NEVER accepts raw payload; the hash is the only acceptable
   binding. *Tracked on #61.*
3. **`event_count` parity with v1 audit bundle.** Proof envelope
   doesn't include it (single-decision proofs). Confirm verifiers
   don't need it for forward compat. *Tracked on #61.*

### Pillar 2

4. **Per-item API keys on batch.** Currently one envelope key per
   batch. Recommend keeping one-key-per-batch until a customer asks
   otherwise. *Tracked on #61.*
5. **Method naming reconciliation.** PR #57 says `evaluateBatch` /
   `evaluate_batch`; PR #77 says `evaluateMany` / `authorize_many`.
   Pick before v2 GA so the v2-preview package can rename. *Tracked
   in this doc.*

### Pillar 3

6. **Reuse of `DecisionEvent` for streaming-evaluate interim
   decisions.** Streaming evaluate from `PROPOSALS/001` could share
   the SSE event union or have its own. Recommend: reuse. *Tracked
   on #61.*
7. **Streaming method naming.** PR #57 says `subscribeDecisions` /
   `subscribe_decisions`; PR #77 says `authorizeStream` /
   `authorize_stream`. Pick before v2 GA. *Tracked in this doc.*

### Pillar 8

8. **Bulk-revoke endpoint shape.** `POST /v2/permits:bulk-revoke`
   keyed on workflow `run_id` + `reason` + optional `revoker_id` is
   the placeholder; real wire shape pending. *Tracked on #79 / #80.*

### GraphQL

9. **Endpoint URL.** `/v2/graphql` is a placeholder. PR #77 didn't
   pin one. *Tracked on #84.*
10. **SDL codegen vs. hand-written queries.** Default in PR #77 is
    hand-written; alternative is generating typed query helpers from
    a schema. Pick before v2 GA so customers know which API surface
    survives. *Tracked on #84.*

### Cross-cutting

11. **Method naming consistency.** PR #57 (pillars) and PR #77
    (capabilities) use different names for the same capabilities
    (batch, streaming). Reconcile pre-GA. *Tracked in this doc.*
12. **`@atlasent/sdk` v1 floor on preview packages.** Currently
    `>=1.4.0`; bump to `>=1.5.0` once PR #83 lands. *Tracked on
    every preview-package PR.*

## What v2 GA still requires (server-side)

The preview packages cover everything that can ship without server
changes. The remaining v2 GA blockers all live server-side:

| Endpoint | Used by | Currently |
|---|---|---|
| `POST /v2/evaluate:batch` | Pillar 2 batch | Polyfilled via N v1 calls |
| `GET /v2/decisions:subscribe` | Pillar 3 SSE | Parser ready; no server stream |
| `POST /v2/permits/:id/consume` | Pillar 9 protect callback | Not wired |
| `GET /v2/proofs/:id` | Pillar 9 fetch | Not wired |
| `POST /v2/proofs/:id/verify` | Pillar 9 online verify | Not wired (offline replay works) |
| `POST /v2/permits:bulk-revoke` | Pillar 8 workflow signal | Stub raises until shipped |
| `/v2/graphql` | GraphQL client | Endpoint URL placeholder |
| Pillar 5 analytics RPCs | Analytics typed client | No design shared |

## Adoption path

Customers wanting to start using v2 ergonomics today:

1. **Install both v1 and v2-preview packages** side-by-side.
   Different package names; they coexist:
   ```bash
   npm install @atlasent/sdk @atlasent/sdk-v2-preview
   pip install atlasent atlasent-v2-preview
   ```

2. **Pin exact preview versions.** No semver discipline pre-GA.

3. **Use the polyfills today.** `evaluateBatchPolyfilled()` runs
   on v1's server. `protect()` callback flow stays on v1 until
   `consume()` ships.

4. **Wire OTel / Sentry adapters today.** They wrap v1 clients —
   no v2 server needed. Provides observability that auto-extends to
   v2 surfaces at GA.

5. **Verify audit bundles offline today.** Both languages ship
   `verifyAuditBundle` / `verify_audit_bundle` already. The Pillar
   9 `replayProofBundle` adds proof-bundle support once the server
   issues real proofs.

6. **Migrate `gate()` callers to `protect()`** before v3. v1.x's
   `gate()` is being deprecated at v2.0 (warning) and removed at v3.

## What this doc tracks vs. drops

**Tracks:**
* Every open PR in the v2 stack with its dependencies
* Open contract questions blocking v2 GA
* Server-side endpoints required for full v2 functionality
* Customer adoption path

**Drops:**
* Per-PR test counts and coverage % — those live in PR bodies
* Implementation details — those live in source comments
* History of which PR superseded which — git log handles that
