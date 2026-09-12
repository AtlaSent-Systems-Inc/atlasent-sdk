// GENERATED-DERIVED — do not edit directly.
// Source: atlasent-keys' .well-known/{atlasent-trust-root,atlasent-verifier-keys,
//   atlasent-revocations}.json — the canonical public trust root published at
//   https://keys.atlasent.io/.well-known/.
// Re-vendor: node scripts/vendor-trust-root.mjs [path/to/atlasent-keys/.well-known]
// Do NOT hand-edit — update atlasent-keys upstream and re-vendor.
//
// This is the SDK's embedded baseline trust-root snapshot (see trustRoot.ts).
// It is a plain object literal on purpose: no file I/O, no path resolution,
// nothing Node-specific, so it is safe to bundle for any target (Node,
// browser, edge). TrustRootManager's background refresh keeps a
// long-running process current between vendoring passes; this baseline is
// what every process has from the very first call, with no network
// round-trip and no reliance on files shipping alongside dist/.

import type { TrustRootSnapshot } from "./trustRoot.js";

export const VENDORED_TRUST_ROOT_SNAPSHOT: TrustRootSnapshot = {
  "valid_until": "2027-06-01T00:00:00Z",
  "issued_at": "2026-05-28T00:00:00Z",
  "keys": [
    {
      "kid": "v2-audit-2026",
      "role": "R3_audit",
      "kty": "OKP",
      "crv": "Ed25519",
      "alg": "EdDSA",
      "x": "IctfKl2VEOaRBX9jvoYnUc2cInF81WgywU5iY3_Ui44",
      "valid_from": "2026-05-28T00:00:00Z",
      "valid_until": "2027-06-01T00:00:00Z",
      "replaced_by": null,
      "revoked": false,
      "tenant": null
    },
    {
      "kid": "test-key",
      "role": "R3_audit",
      "kty": "OKP",
      "crv": "Ed25519",
      "alg": "EdDSA",
      "x": "uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ",
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": "2027-01-01T00:00:00Z",
      "replaced_by": "v2-audit-2026",
      "revoked": true,
      "tenant": null
    },
    {
      "kid": "permit-kid",
      "role": "R2_permit",
      "kty": "OKP",
      "crv": "Ed25519",
      "alg": "EdDSA",
      "x": "uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ",
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": "2027-01-01T00:00:00Z",
      "replaced_by": "ak_2026_q3_atlasent_permit",
      "revoked": true,
      "tenant": null
    },
    {
      "kid": "revoked-kid",
      "role": "R3_audit",
      "kty": "OKP",
      "crv": "Ed25519",
      "alg": "EdDSA",
      "x": "uCfAGR92U9gKXqMmGs4MCoaTq-LmzoRe_aiwZE6UcnQ",
      "valid_from": "2026-01-01T00:00:00Z",
      "valid_until": "2027-01-01T00:00:00Z",
      "replaced_by": null,
      "revoked": true,
      "tenant": null
    },
    {
      "kid": "ak_2026_q3_atlasent_permit",
      "role": "R2_permit",
      "tenant": "atlasent",
      "kty": "OKP",
      "crv": "Ed25519",
      "alg": "EdDSA",
      "x": "3psqJ3CGPIKe4N2oSgu75f1cnJgnbWLcBFThFk4N_qc",
      "valid_from": "2026-07-01T00:00:00Z",
      "valid_until": "2027-01-01T00:00:00Z",
      "replaced_by": null,
      "revoked": false
    }
  ],
  "revoked_keys": [
    {
      "kid": "revoked-kid",
      "role": "R3_audit",
      "revoked_at": "2026-05-28T00:00:00Z",
      "reason": "Test key; superseded by v2-audit-2026"
    },
    {
      "kid": "test-key",
      "role": "R3_audit",
      "revoked_at": "2026-06-10T00:00:00Z",
      "reason": "Replaced by v2-audit-2026; revocation flag corrected to match replaced_by field"
    },
    {
      "kid": "permit-kid",
      "role": "R2_permit",
      "revoked_at": "2026-08-10T09:39:34Z",
      "reason": "Vendor-fixture placeholder R2_permit key, superseded by ak_2026_q3_atlasent_permit; revoked in atlasent-verifier-keys.json commit 0f97f0c but omitted from this ledger at the time"
    }
  ],
  "revoked_identities": []
};
