# Release Notes

## v2.0.0-alpha.0 / 2.0.0a0 — v2 alpha (TS + Py)

**Release date:** 2026-04-27

The first publishable v2 surface, gated behind `-alpha` semantics:
breaking changes are still on the table between alpha releases.

### Packages

| Language   | Package                              | Install                                                |
|------------|--------------------------------------|--------------------------------------------------------|
| Python     | `atlasent-v2-alpha` `2.0.0a0`        | `pip install atlasent-v2-alpha`                        |
| TypeScript | `@atlasent/sdk-v2-alpha` `2.0.0-alpha.0` | `npm install @atlasent/sdk-v2-alpha@alpha` |

Both packages install cleanly **alongside** the v1 packages
(`atlasent`, `@atlasent/sdk`). The v1 surface is unchanged and remains
stable at v1.x.

### What's in v2-alpha

**Pillar 9 primitives** — deterministic JSON canonicalization and
SHA-256 hashing identical with v1's `canonical_json` /
`canonicalJSON`, plus wire-mirror types for every v2 schema in
`contract/schemas/v2/`.

**HTTP methods** on `V2Client` (TS) / `AtlaSentV2Client` (Py):

- `consume(permitId, payloadHash, executionStatus, executionHash?)`
  → `ConsumeResponse`. Closes the permit lifecycle by recording the
  outcome of the wrapped callback. The raw payload is never sent —
  only its `payload_hash`.
- `verifyProof(proofId)` / `verify_proof(proof_id)` →
  `ProofVerificationResult`. Server-side proof verification; returns
  the canonical envelope the offline CLI also emits.
- `evaluateBatch(requests)` / `evaluate_batch(requests)` →
  `EvaluateBatchResponse`. Pillar 2 batched evaluate — one HTTP
  call for N decisions (≤ 1000), one rate-limit decrement,
  order-preserving (`items[i]` decides `requests[i]`).
- `subscribeDecisions({ lastEventId?, signal? })` /
  `subscribe_decisions(*, last_event_id=None)` → async iterable
  of `DecisionEvent`. Pillar 3 SSE stream with reconnect
  (Last-Event-ID), abort (TS), forward-compat unknown event types,
  malformed-frame skip semantics.

Both languages export the SSE parser they use (`parseSSE` /
`parse_sse_lines` + `parse_sse_bytes`) for callers who want to handle
the stream themselves.

### Error handling

Single error type `V2Error` (both languages) with `status`/`code`
fields:

- `invalid_api_key` (401)
- `http_error` (other 4xx/5xx)
- `network` (transport failure)
- `timeout` (per-request deadline)
- `bad_response` (malformed 2xx body)
- `invalid_argument` (client-side guard fired before the wire call)

### Stability

The v2-alpha line follows alpha-release semantics — **no semver
discipline between alpha releases**. Pin to an exact version
(`atlasent-v2-alpha==2.0.0a0` /
`@atlasent/sdk-v2-alpha@2.0.0-alpha.0`) if you depend from production
code. Beta will tighten this; the GA `atlasent-v2` / `@atlasent/sdk`
v2.x packages will fold the alpha surface back under semver.

### Cross-language parity

`canonicalize_payload` / `canonicalizePayload` produces byte-identical
output across Python and TypeScript on every test vector in
`contract/schemas/v2/`. The schema-parity tests assert that every
required schema field is declared on the corresponding model/type;
drift fails CI.

---

## v1.5.0 — Audit listing, signed exports, offline verification

**Release date:** 2026-04-25

Closes the long-standing `/v1-audit` parity gap. With this release, a
caller can go from "I have an API key" to "I have a signed,
offline-verifiable bundle of my org's audit events" without leaving
the SDK — same primitives in TypeScript and Python, same wire shapes,
same crypto guarantees.

### TypeScript (`@atlasent/sdk@1.5.0`)

- **`AtlaSentClient.listAuditEvents()`** — paginated list of audit
  events, filterable by `types` / `actor_id` / `from` / `to`. Returns
  `AuditEventsResult` with `events`, `total`, `next_cursor`, and the
  shared `rateLimit` field.
- **`AtlaSentClient.createAuditExport()`** — returns a signed
  `AuditExportResult` whose envelope drops directly into the offline
  verifier. Signature, hash chain head, and event payloads are
  preserved byte-for-byte.
- **Offline audit-bundle verifier** — `verifyBundle(path, {
  publicKeysPem })` and `verifyAuditBundle(bundle, keys)`. Per-event
  SHA-256 hash chain, adjacency, `chain_head_hash` match, and
  detached Ed25519 signature. Rotation-aware via `signing_key_id`.
  Runs on Node 20+ using `crypto.webcrypto.subtle`; no extra deps.
- **Shared audit wire types** — `AuditEvent`, `AuditEventsPage`,
  `AuditEventsQuery`, `AuditExport`, `AuditDecision`, and
  `AuditExportSignatureStatus` are all exported. Type-level sync
  assertions lock the field set against the server contract so wire
  drift fails CI.

### Python (`atlasent==1.5.0`)

- **`AtlaSentClient.list_audit_events()` / `create_audit_export()`**
  on both sync and async clients. Mirrors the TS surface; uses
  pydantic models for the list path and a dataclass-wrapped raw dict
  for the export path so the signature round-trips byte-for-byte.
- **Offline audit-bundle verifier** —
  `atlasent.verify_bundle(path, public_keys_pem=[...])` and the
  lower-level `atlasent.audit_bundle.verify_audit_bundle(bundle,
  keys)`. Byte-faithful port of the reference verifier in
  `atlasent-api/supabase/functions/v1-audit/verify.ts`.
  `cryptography` is now a hard dependency.
- **New public exports** from the `atlasent` package:
  `AuditEvent`, `AuditEventsResult`, `AuditExportResult`,
  `AuditDecision`, `AuditExportSignatureStatus`, plus
  `canonical_json` / `signed_bytes_for` for regulator-side tooling.

### Shared contract

Both SDKs ship matching test fixtures at
`contract/vectors/audit-bundles/` and a reproducible generator at
`contract/tools/gen_audit_bundles.py`. The drift checker
(`contract/tools/drift.py`) enforces that both SDKs serialize and
verify bundles identically.

### Breaking changes

None — purely additive. Existing `evaluate` / `verifyPermit` /
`protect` / `keySelf` callers keep working unchanged.

### Upgrade notes

```bash
npm install @atlasent/sdk@1.5.0
pip install atlasent==1.5.0
```

### Stability guarantees

The audit surface (`listAuditEvents` / `createAuditExport` /
`verifyBundle` and their Python equivalents) is now part of the v1
public contract. Pin to `>=1.5.0,<2.0.0` to consume the new audit
APIs while staying within the v1 stability window.

---

## Previous releases

- **v1.4.0** (2026-04-23) — `keySelf()` API-key self-introspection on
  both SDKs.
- **v1.3.0** (2026-04-23) — `rateLimit` / `rate_limit` on every
  authed response.
- **v1.2.0** (2026-04-23, TS only) — `@atlasent/sdk/hono` Hono
  middleware. Python parity follows.
- **v1.1.0** (2026-04-22 TS / 2026-04-23 Python) — `protect()`
  fail-closed authorization primitive.
- **v1.0.0** (2026-04-17) — first stable release of both SDKs.

See `python/CHANGELOG.md` and `typescript/CHANGELOG.md` for the full
per-version detail.
