# AtlaSent v2 contract schemas — DRAFT

**Status:** `DRAFT` — do not implement until v1 GA. Do not merge until
v2 GA. This directory is the v2 counterpart to `contract/schemas/`
(v1); keeping them in separate directories means the v1 drift
detector (`contract/tools/drift.py`) keeps running unchanged while
the v2 surface stabilises.

## What's in here

| Schema | Endpoint | Companion doc |
|--------|----------|---------------|
| `proof.schema.json` | `GET /v2/proofs/:id` | `docs/V2_PILLAR9_PROOF_SYSTEM.md` |
| `consume-request.schema.json` | `POST /v2/permits/:id/consume` (req) | Pillar 9 |
| `consume-response.schema.json` | `POST /v2/permits/:id/consume` (res) | Pillar 9 |
| `proof-verification-result.schema.json` | `POST /v2/proofs/:id/verify` | Pillar 9 |
| `evaluate-batch-request.schema.json` | `POST /v2/evaluate:batch` (req) | `docs/V2_PLAN.md` §Pillar 2 |
| `evaluate-batch-response.schema.json` | `POST /v2/evaluate:batch` (res) | Pillar 2 |
| `decision-event.schema.json` | `GET /v2/decisions:subscribe` (SSE) | Pillar 3 |

Not yet drafted here:

- **Pillar 5 (analytics RPCs)** — `denialTrends`, `policyDrift`,
  `riskOverTime`, `agentScorecard`. Wire shapes depend on the
  analytics backend design; deferred until that lands.
- **Pillar 8 (Temporal adapter)** — SDK-side only, no new wire
  endpoints. Lives in the future `@atlasent/temporal` /
  `atlasent-temporal` packages, not here.
- **Streaming evaluate** — separate surface from decision events.
  Proposal `contract/PROPOSALS/001-streaming-evaluate.md` has six
  open questions that need API team input before a schema makes
  sense.

## Cross-cutting decisions baked into these drafts

1. **Snake_case on the wire.** Matches v1. SDKs keep their camelCase
   surfaces; the translation boundary sits at the HTTP client.
2. **`api_key` in the body.** Preserved from v1 so the drift detector
   and existing validation kits (`contract/adopt/`) continue to work
   against v2 requests with the same envelope discipline.
3. **Signed proof envelope.** Declaration order in
   `proof.schema.json` IS the signed-byte order. Mirrors
   `audit-bundle.schema.json`'s relationship with
   `v1-audit/index.ts::handleExport`. Reordering fields in this
   schema changes what verifiers compute — treat as a breaking
   change.
4. **Per-event payload sub-schemas are informational.** On
   `decision-event.schema.json`, the `payload` field is
   `additionalProperties: true` so old SDKs against new servers
   don't choke on new fields. The `$defs` document the canonical
   shape; drift tooling will grow coverage as each event type
   stabilises.
5. **Pillar 9 + Pillar 2 integrate cleanly.** `evaluate-batch`'s
   per-item response carries optional `proof_id` + `proof_status`
   so a customer can batch-evaluate and still get per-item proofs
   without two round-trips.

## Open contract-level questions

Tracked explicitly in each schema's `description` — search for "Open
question:" across the files. Summary:

1. **Raw vs. pre-hashed payload.** `ConsumeRequest.payload_hash`
   requires the client to hash before calling; the SDK does this
   under the hood. Confirm the server NEVER accepts a raw payload
   on `/consume` — customer data must stay off the wire.
2. **Per-item API keys on batch.** Currently one envelope key per
   batch. Per-item keys would enable cross-org batching; recommend
   keeping one-key-per-batch until a customer needs otherwise.
3. **Reuse of `DecisionEvent` for streaming evaluate.** See
   PROPOSALS/001 — recommendation is to reuse, but needs API sign-off.
4. **`event_count` parity with v1 audit bundle.** The Proof
   envelope doesn't include `event_count` (unlike v1's audit
   bundle) because a proof wraps a single decision. Confirm
   verifiers don't need it for forward compatibility with future
   aggregate proofs.

## What's NOT in these drafts (and why)

- **Code.** Schemas only. Any SDK code must wait until v1 GA.
- **Drift detector wiring.** `contract/tools/drift.py` still only
  covers v1 endpoints. Extending it to v2 is a follow-up PR once
  the v2 schemas solidify and at least one SDK wires the
  corresponding method.
- **OpenAPI document.** `contract/openapi.yaml` describes v1. A v2
  companion (or a single merged doc at GA) is a follow-up.
- **Test vectors.** `contract/vectors/v2/` will land alongside the
  first SDK implementation so the vectors exercise a real client
  round-trip, not a schema-only exercise.

## Review checklist for merging (v2 GA)

Before this directory leaves draft status:

- [ ] Every schema's open question is resolved and the resolution
      is captured in the `description`.
- [ ] `contract/tools/drift.py` covers each endpoint represented
      here.
- [ ] Test vectors exist at `contract/vectors/v2/` for round-trip
      validation.
- [ ] `contract/openapi.yaml` either merges v1+v2 or a
      `contract/openapi-v2.yaml` sibling lands.
- [ ] SDK_COMPATIBILITY.md has a v2 section.
- [ ] Both SDKs implement the corresponding methods and the
      integration suite is green against staging.
