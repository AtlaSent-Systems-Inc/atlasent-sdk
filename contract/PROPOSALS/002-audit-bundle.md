# Proposal 002 — Offline audit-bundle format

**Status:** `DRAFT` (partially resolved — see Status update below)
**Needs decisions from:** API team (bundle container + field layout),
security team (crypto suite + key management + canonicalization), ops
(public key distribution + rotation).

## Status update — 2026-05-26

Open questions **2** (public key distribution) and **3** (key
rotation + historical bundles) are **resolved** by the canonical
trust-root architecture:

- [ADR-005](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/docs/adr/ADR-005-trust-root-semantics.md) decisions **D1** (single global JWKS in V1; `tenant` field reserved for V2), **D2** (4h refresh target, 5min floor), **D3** (fail-closed snapshot expiry by default; `allow_expired_snapshot` opt-out for air-gap).
- [`atlasent/schemas/trust-root/v1/atlasent-verifier-keys.schema.json`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/schemas/trust-root/v1/atlasent-verifier-keys.schema.json) — the canonical JWKS shape with `kid`, `role`, `valid_from`, `valid_until`, `replaced_by`, `revoked`. Historical bundles remain verifiable because retired keys stay in the JWKS with `replaced_by` pointing at their successor.
- [`atlasent/docs/design/TRUST_ROOT_ARCHITECTURE.md`](https://github.com/AtlaSent-Systems-Inc/atlasent/blob/main/docs/design/TRUST_ROOT_ARCHITECTURE.md) §3.4 (JWKS layout), §5.1 (SDK hybrid trust-snapshot bootstrap), §9 (rotation/revocation runbooks).

The SDK implementation work for the hybrid bootstrap + revocation
enforcement is tracked in
[`atlasent-sdk#289`](https://github.com/AtlaSent-Systems-Inc/atlasent-sdk/issues/289)
and will replace the placeholder PROPOSAL-002 §3.2 "default
(c) + (d) fallback" recommendation with the now-canonical hybrid
model.

Questions **1** (bundle container — NDJSON vs zip vs CBOR), **4**
(chain anchor), **5** (redaction / replay), and **6** (verification
levels) remain in scope for this proposal.

## Problem statement

GxP / 21 CFR Part 11 / financial-audit regulators routinely want to
verify a record of decisions **without trusting the AtlaSent API at
verification time**. Use cases:

- An FDA inspector hands a clinical-trial sponsor a list of patient
  record changes and asks "prove every one was authorized."
- A SOX auditor asks for the full decision trail for every wire
  transfer over $X in Q3.
- A customer's legal team reviewing a compliance incident wants to
  verify that the SDK-emitted audit hashes they logged match what
  the server actually signed, in an air-gapped environment.

V1_PLAN calls for an offline verifier: "both SDKs ship a
`verify_bundle(path)` that validates an Ed25519-signed export
without hitting the API." This proposal picks a concrete bundle
format, canonicalization scheme, and verification algorithm so both
SDKs implement identical semantics.

## Proposed bundle format

**Container: JSON Lines (NDJSON)** with a single JSON header line
followed by one audit event per line, terminated by a final signature
line. Filename convention: `<prefix>-<iso8601>.atlasent-bundle.jsonl`.

Rationale:
- Line-oriented → streaming verification without loading the whole
  bundle into memory (a one-year audit export can be hundreds of MB).
- JSON (not CBOR / protobuf) → hand-inspectable with `jq` / `less`,
  no extra toolchain.
- Single file (not a tar / zip) → fewer containers that can silently
  be swapped.

### File layout

Line 1 — **header**:

```json
{"atlasent_bundle":"v1","key_id":"ak_2026_q2","sig_alg":"ed25519","bundle_id":"bnd_01J8...","issued_at":"2026-04-23T00:00:00Z","event_count":12345,"chain_anchor":"sha256:0000...0000"}
```

Lines 2..N — **audit events**, one per line, in chain order. Exact
shape mirrors today's `EvaluateResponse.audit_hash` source record,
but with the hash-chain pointers made explicit:

```json
{"seq":1,"prev_hash":"sha256:0000...0000","audit_hash":"sha256:a1b2...","decision_id":"dec_...","permitted":true,"agent":"...","action":"...","context":{...},"reason":"...","timestamp":"2026-04-23T10:00:00Z","engine_version":"atlasent-engine/1.4.2"}
{"seq":2,"prev_hash":"sha256:a1b2...","audit_hash":"sha256:c3d4...",...}
...
```

Each event's `prev_hash` MUST equal the previous event's `audit_hash`.
The first event's `prev_hash` MUST equal the header's `chain_anchor`.

Line N+1 — **signature**:

```json
{"signature":"base64-ed25519-signature-64-bytes"}
```

The signature covers the concatenation of lines 1..N verbatim
(including the trailing `\n` after each line; NO canonicalization of
individual JSON lines — the exact bytes the server emitted are what
gets signed).

### Canonicalization of individual events

**None within a line.** Each event is whatever JSON the server chose
to emit, byte-for-byte. Signing the file's raw bytes avoids the
whole class of canonicalization bugs where a verifier that
pretty-prints JSON, sorts keys, or normalizes Unicode gets a
different hash than the signer.

This is the classic "sign what you send, verify what you got"
approach — the bundle IS the canonical form. Verifiers do NOT
re-serialize.

### Signing algorithm

**Ed25519**, per RFC 8032. Signature is the raw 64-byte output,
base64-encoded (standard alphabet, no line breaks, no padding
stripped). Public key distribution is handled separately (see below).

### Verification algorithm

```
1. Read file line by line; collect signature line (last); collect all
   other lines (header + events) as raw bytes.
2. Parse header. Reject if `atlasent_bundle` != "v1" or `sig_alg`
   != "ed25519".
3. Look up public key by `key_id` (see "Public key distribution").
4. Concatenate lines 1..N including their terminating `\n`;
   verify Ed25519 signature over those bytes. Reject if invalid.
5. Parse each event line. Reject if any line fails JSON.parse or
   doesn't have the required fields.
6. Walk events in order:
   a. event[0].prev_hash MUST equal header.chain_anchor.
   b. event[i].prev_hash MUST equal event[i-1].audit_hash.
   c. event[i].seq MUST equal i+1 (1-indexed).
   Reject on any mismatch.
7. Return BundleVerification { bundle_id, event_count, key_id, ok: true }.
```

Failure paths return `ok: false` plus a human-readable reason; SDKs
expose the reason for audit tooling to display.

## Open questions

1. **Bundle container: NDJSON vs. zip-with-manifest vs. CBOR.**
   NDJSON is the proposal; alternatives are (a) a signed zip
   containing a manifest JSON + per-event files (easier for
   regulators to browse with GUI tools), (b) CBOR-sequence encoding
   (smaller + type-safe but requires extra libs in both SDKs).
   Security team + regulator-facing teams to weigh in on what
   auditors actually prefer holding.

2. ~~**Public key distribution.**~~ **RESOLVED — see Status update
   above.** Hybrid model: SDK ships a pinned snapshot of the JWKS
   at build time and optionally refreshes from
   `https://keys.atlasent.io/.well-known/atlasent-verifier-keys.json`
   on a 4h cadence (per ADR-005 D2). Refresh failure falls back to
   the pinned snapshot. Customer-supplied trust stores remain
   supported for air-gap via `--trust-store` on the CLI and
   `allow_expired_snapshot` on the SDK (per ADR-005 D3).

3. ~~**Key rotation + historical bundles.**~~ **RESOLVED — see
   Status update above.** The JWKS carries every key ever issued
   (active, retired, revoked) with `valid_from` / `valid_until` /
   `replaced_by`. Verifiers check that the bundle's `issued_at`
   falls within the `key_id`'s validity window and that the KID is
   not on `atlasent-revocations.json`. The architecture doc §9
   covers the operator-side rotation procedure (planned + emergency).

4. **Chain anchor.** Where does `chain_anchor` (the `prev_hash` for
   the first event in a bundle) come from? Three options:
   - **(a) Fixed all-zeros for every bundle** (simple but loses
     chain continuity across bundles).
   - **(b) The `audit_hash` of the last event in the previous
     bundle** (chains bundles together; requires the verifier to
     validate bundles in order, or at least validate the chain
     anchor matches a known state).
   - **(c) Pinned per-customer genesis hash** baked in at
     organization setup; every bundle chains back to that anchor.
   Proposal recommends **(b)** with the customer's genesis hash as
   the seed for their very first bundle.

5. **Redaction / replay.** If an event's `context` contains PHI /
   PII that must be redacted before the bundle leaves the AtlaSent
   environment, what's the process? Redacting any field breaks the
   signature (signing-what-you-send). Options: (a) the server
   exports a pre-redacted bundle signed over the redacted bytes
   (customer must request the redaction scheme up front), (b)
   bundles ship unredacted and the customer is trusted to handle
   PHI appropriately. Proposal: (a), with a separate proposal
   later to specify the redaction-fields negotiation.

6. **What "verified" actually means.** Four levels of verification:
   - L1: signature valid.
   - L2: signature valid + hash chain intact.
   - L3: L2 + every event's `audit_hash` matches what the SDK /
     console logged client-side (requires the caller to provide the
     expected hashes).
   - L4: L3 + timestamps monotonically non-decreasing + within
     expected time window.
   The proposal ships L2 as `verify_bundle(path)`'s default (that's
   what regulators typically need); L3 + L4 are follow-up toggles
   (`check_client_hashes=`, `check_timestamps=`).

## SDK implementation sketch

### TypeScript

```ts
import { verifyBundle, BundleVerificationError } from "@atlasent/sdk";

const result = await verifyBundle("./audit-2026-Q2.atlasent-bundle.jsonl");
// result: { ok: true, bundleId, eventCount, keyId, issuedAt }
//      OR { ok: false, reason: "signature invalid" }

if (!result.ok) {
  throw new BundleVerificationError(result.reason);
}
```

Implementation uses `node:fs.createReadStream` + `readline` +
`node:crypto.verify("ed25519", ...)`. No extra dependencies —
everything in the Node stdlib.

### Python

```python
from atlasent import verify_bundle, BundleVerificationError

result = verify_bundle("./audit-2026-Q2.atlasent-bundle.jsonl")
# result: BundleVerification(ok=True, bundle_id=..., event_count=...,
#                            key_id=..., issued_at=...)
#      or BundleVerification(ok=False, reason="signature invalid")

if not result.ok:
    raise BundleVerificationError(result.reason)
```

Implementation uses `cryptography.hazmat.primitives.asymmetric.ed25519`.
Requires adding `cryptography` to `pyproject.toml` dependencies — the
SDK was previously dep-free on crypto.

### Error taxonomy

One new error class in each SDK:

- **`BundleVerificationError`** (extends `AtlaSentError`). Distinct
  from auth-time errors because verification happens offline and
  has a different remediation story (check the key store, re-fetch
  keys, re-download the bundle).

Carries `bundle_id` (when readable), `key_id` (when readable), and
`reason` — the specific failure cause from the verification algorithm.

## Test vector requirements

New vectors under `contract/vectors/bundles/`:

- **Positive fixtures** (must verify):
  - `bundle_minimal_allow_only.jsonl` — header + 3 ALLOW events +
    signature.
  - `bundle_mixed_allow_deny.jsonl` — header + 5 events (mixed
    permitted true/false) + signature.
  - `bundle_large.jsonl` — header + 10,000 events + signature (to
    exercise streaming verification).

- **Negative fixtures** (must fail verification with specific
  reasons):
  - `INVALID_tampered_event.jsonl` — one event's `context` altered;
    signature invalid.
  - `INVALID_broken_chain.jsonl` — event[2].prev_hash doesn't match
    event[1].audit_hash.
  - `INVALID_bad_signature.jsonl` — header + events valid, but
    signature is wrong.
  - `INVALID_unknown_key_id.jsonl` — `key_id` in header not in the
    trust store.
  - `INVALID_wrong_version.jsonl` — `atlasent_bundle: "v2"` (SDK
    rejects until v2 is specified).

Each comes with an accompanying `<name>.expected.json` describing
the expected `BundleVerification` output.

Plus a synthetic test-only public key pair checked into
`contract/vectors/bundles/test-keys/` for reproducible vector
generation — NEVER used in production.

## Not in scope for this proposal

- **Bundle generation** server-side. This proposal covers only the
  consumer (verifier) side — the shape the server produces. How the
  server builds bundles, who can request one, and the export
  workflow are API-team concerns handled in a separate spec.
- **Tamper-evident live verification.** The verifier here is
  offline / batch. Streaming / per-event verification during normal
  SDK usage is out of scope — today's `verify_permit` already
  covers per-decision verification at call time.
- **Hardware-backed keys.** The proposal assumes software Ed25519
  keys. HSM-backed signing is a server-side concern that doesn't
  affect the verification algorithm.
