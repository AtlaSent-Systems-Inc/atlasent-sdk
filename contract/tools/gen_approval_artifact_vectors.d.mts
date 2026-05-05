// Type declarations for the approval-artifact vector generator. The
// runtime is ESM JavaScript (.mjs); this file lets the vitest drift
// test import it under strict TypeScript without `any`.

export interface VerifierInputs {
  trusted_issuers: Record<string, Record<string, { alg: "HS256" | "Ed25519"; key: string; allowed_action_types?: string[]; allowed_environments?: string[]; required_role?: string }>>;
  trusted_identity_issuers?: Record<string, Record<string, { alg: "HS256" | "Ed25519"; key: string; allowed_roles?: string[]; allowed_environments?: string[] }>>;
  expected_action_hash: string;
  expected_tenant_id: string;
  required_role: string;
  expected_environment: string;
  now_iso: string;
  hs256_test_key_hex: string;
  hs256_identity_test_key_hex?: string;
  /** When true, the verifier requires a verifiable identity_assertion. */
  require_identity_assertion?: boolean;
}

export interface IdentityAssertionV1 {
  version: "identity_assertion.v1";
  subject: { principal_id: string; principal_kind: "human" | "agent" | "service_account" };
  role: string;
  binding: { approval_id: string; action_hash: string; tenant_id: string; environment: string };
  issuer: { type: "oidc"; issuer_id: string; kid: string };
  issued_at: string;
  expires_at: string;
  nonce?: string;
  signature: string;
}

export interface ArtifactReviewer {
  principal_id: string;
  principal_kind: "human" | "agent" | "service_account";
  email?: string;
  groups?: string[];
  roles?: string[];
}

export interface ArtifactIssuer {
  type: "oidc" | "approval_service";
  issuer_id: string;
  kid: string;
}

export interface ApprovalArtifactV1 {
  version: "approval_artifact.v1";
  approval_id: string;
  tenant_id: string;
  action_type: string;
  resource_id: string;
  action_hash: string;
  reviewer: ArtifactReviewer;
  issuer: ArtifactIssuer;
  issued_at: string;
  expires_at: string;
  nonce: string;
  signature: string;
  identity_assertion?: IdentityAssertionV1;
}

export interface VectorBase {
  name: string;
  description: string;
  inputs: VerifierInputs;
  artifact: ApprovalArtifactV1;
}

export type VerifySuccess = { ok: true; approval_id: string; reviewer_id: string };
export type VerifyFailure = { ok: false; reason: string };

export interface SingleOutcomeVector extends VectorBase {
  expected_outcome: VerifySuccess | VerifyFailure;
}

export interface ReplayOutcomeVector extends VectorBase {
  expected_outcome: { first: VerifySuccess; second: VerifyFailure };
}

export type Vector = SingleOutcomeVector | ReplayOutcomeVector;

export const VECTORS: Vector[];
export const QUORUM_VECTORS: QuorumVector[];
export const NOW_ISO: string;
export const NOW_MS: number;
export const HEX_KEY: string;
export const ID_HEX_KEY: string;
export const TRUSTED_ISSUERS: VerifierInputs["trusted_issuers"];
export const TRUSTED_IDENTITY_ISSUERS: NonNullable<VerifierInputs["trusted_identity_issuers"]>;

// ── Quorum types ─────────────────────────────────────────────────────

export interface QuorumIndependence {
  distinct_approval_issuers?: boolean;
  distinct_identity_issuers?: boolean;
}

export interface QuorumRoleRequirement {
  role: string;
  min: number;
}

export interface QuorumPolicy {
  required_count: number;
  required_role_mix?: QuorumRoleRequirement[];
  independence?: QuorumIndependence;
  max_age_seconds?: number;
}

export interface ApprovalQuorumV1 {
  version: "approval_quorum.v1";
  tenant_id: string;
  action_hash: string;
  environment: string;
  issued_at: string;
  policy: QuorumPolicy;
  approvals: ApprovalArtifactV1[];
}

export interface QuorumVerifierInputs extends VerifierInputs {}

export type QuorumSuccess = { ok: true; count: number };
export type QuorumFailure = { ok: false; reason: string };

export interface QuorumVector {
  name: string;
  description: string;
  inputs: QuorumVerifierInputs;
  package: ApprovalQuorumV1;
  expected_outcome: QuorumSuccess | QuorumFailure;
}

export function canonicalStringify(obj: unknown): string;
export function sha256Hex(s: string): string;
export function hmacHex(payload: string, hexKey: string): string;
export function actionHash(input: {
  action_type: string;
  actor_id: string;
  resource_id: string;
  amount?: number | null;
  context?: Record<string, unknown>;
  environment?: string | null;
  policy_version?: string | null;
}): string;
export function makeArtifact(overrides?: Partial<ApprovalArtifactV1>): ApprovalArtifactV1;
