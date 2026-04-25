# @atlasent/verify

Zero-dependency offline verifier for AtlaSent signed audit-export
bundles. Designed so an auditor can verify a bundle on a fresh machine
without installing the rest of the AtlaSent SDK.

## Install

Run it ad-hoc with `npx` — no install required:

```sh
npx @atlasent/verify ./bundle.json
```

Or add it to a project:

```sh
npm install --save-dev @atlasent/verify
```

## Usage

### CLI

```sh
# Chain integrity only (signature reported as unverified):
npx @atlasent/verify ./bundle.json

# Full verification with the active trust set:
npx @atlasent/verify ./bundle.json --pem ./signing-key.pub.pem
```

The CLI prints `verified: true` to stdout and exits 0 on success;
prints `verified: false` plus a `reason:` line on stderr and exits 1
on any failure.

### Programmatic

```ts
import { verifyBundle } from "@atlasent/verify";
import { readFileSync } from "node:fs";

const result = await verifyBundle("./bundle.json", {
  publicKeysPem: [readFileSync("./signing-key.pub.pem", "utf8")],
});

if (!result.verified) {
  throw new Error(`bundle did not verify: ${result.reason}`);
}
```

## What is verified

Three independent checks, all reported on the result object:

1. **Chain integrity** (`chainIntegrityOk`) — every event's
   `previous_hash` equals the prior event's `hash`, every event's
   `hash` matches `SHA-256(previous_hash || canonicalJSON(payload))`,
   and `chain_head_hash` matches the last event's stored `hash`.
2. **Signature** (`signatureValid`) — Ed25519 over the canonical
   envelope `(export_id, org_id, chain_head_hash, event_count,
   signed_at, events)` verifies under one of the supplied public keys.
3. **Tampered events** (`tamperedEventIds`) — the per-event ids whose
   recomputed hash didn't match the stored hash. Even if the signature
   verifies, this list must be empty for the bundle to be trustworthy.

`verified` is the convenience AND of (1) and (2).

## Source-of-truth note

The verification logic in this package is byte-identical with the
in-SDK `verifyBundle()` exported from `@atlasent/sdk` and with the
reference verifier in
`atlasent-api/supabase/functions/v1-audit/verify.ts`. When the bundle
format evolves, the change goes through `contract/schemas/` first;
this package and the SDK both update together.

## License

Apache-2.0
