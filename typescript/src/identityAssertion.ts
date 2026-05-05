/**
 * Public types for the AtlaSent **Identity Assertion** — a signed
 * attestation from an identity provider (OIDC / SSO) that the
 * reviewer named in an approval_artifact.v1 is a real human with a
 * specific role.
 *
 * Wire-stable as `identity_assertion.v1`. The contract lives in
 * `contract/schemas/identity-assertion.schema.json`. Verification is
 * server-side inside `/v1-evaluate`; the SDK exposes the types so
 * callers can construct or inspect the `identity_assertion` block on
 * an approval artifact.
 *
 * Why this matters: without identity attestation the artifact's
 * `reviewer.principal_kind: "human"` is a self-claim from the
 * approval issuer alone. With it, the IdP independently vouches for
 * the human — a separate trust root, defence in depth.
 */

import type { PrincipalKind } from "./approvalArtifact.js";

/** Identity-attested subject of the assertion. The verifier requires
 *  `principal_kind === "human"`; the other variants exist so the
 *  schema can structurally describe denied/declined assertions. */
export interface IdentitySubject {
  principal_id: string;
  principal_kind: PrincipalKind;
}

/** Cryptographic binding tying the assertion to a specific approval. */
export interface IdentityAssertionBinding {
  /** Must equal artifact.approval_id. */
  approval_id: string;
  /** Must equal the canonical action hash. */
  action_hash: string;
  /** Must equal the request's tenant_id. */
  tenant_id: string;
  /** Must equal the request's environment. Empty string allowed when
   *  the verifier was not given one (explicit equality, no implicit
   *  broadening). */
  environment: string;
}

/** Identity issuer (the IdP). Always OIDC-shaped. */
export interface IdentityIssuer {
  type: "oidc";
  issuer_id: string;
  /** Key id for rotation; looked up in IDENTITY_TRUSTED_ISSUERS. */
  kid: string;
}

/** A complete signed identity assertion. */
export interface IdentityAssertionV1 {
  version: "identity_assertion.v1";
  subject: IdentitySubject;
  /** Required role attested by the IdP (e.g. "qa_reviewer"). */
  role: string;
  binding: IdentityAssertionBinding;
  issuer: IdentityIssuer;
  issued_at: string;
  expires_at: string;
  /** Optional anti-replay nonce. The approval-artifact nonce is the
   *  primary defence; deployments wanting assertion-level replay
   *  protection ledger this separately. */
  nonce?: string;
  signature: string;
}

/** Per-issuer entry in IDENTITY_TRUSTED_ISSUERS. Server-side config
 *  only — never on the wire. The SDK exposes the type so operators
 *  can lint config in CI. */
export interface IdentityIssuerKey {
  alg: "HS256" | "Ed25519";
  key: string;
  /** Per-issuer scope: roles this kid may attest. Empty/missing = unscoped. */
  allowed_roles?: string[];
  /** Per-issuer scope: environments this kid may attest in. Empty/missing = unscoped. */
  allowed_environments?: string[];
}

/** JSON shape of IDENTITY_TRUSTED_ISSUERS. Keyed by issuer_id then by
 *  kid. Independent trust root from APPROVAL_TRUSTED_ISSUERS. */
export type IdentityTrustedIssuersConfig = Record<
  string,
  Record<string, IdentityIssuerKey>
>;
