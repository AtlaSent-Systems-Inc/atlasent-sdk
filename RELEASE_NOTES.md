# Release Notes — v1.5.0

**Release date:** 2026-04-25

## AtlaSent SDK v1.5.0 — Audit listing, signed exports, offline verification

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
