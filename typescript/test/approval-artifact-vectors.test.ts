// Contract drift test for approval_artifact.v1.
//
// Three layers:
//   1. Generator drift — re-run the fixture generator in-process and
//      compare to what's on disk. Catches accidental hand-edits.
//   2. Schema drift — every required field declared in the JSON
//      Schema must be present on every fixture's artifact, and types
//      match the schema's primitive expectations. Catches drift
//      between fixtures and contract/schemas/approval-artifact.schema.json.
//   3. Verifier drift — a TS mirror of the Deno verifier is run
//      against each fixture and the outcome must match
//      `expected_outcome`. Catches drift between schema, fixtures,
//      and the verifier algorithm (canonical bytes, ordering of
//      checks, signature integrity).
//
// All three running together means: a change in any of the four
// surfaces (schema, generator, fixtures, verifier algorithm) without
// the others breaks the test.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, createHmac } from "node:crypto";
import {
  VECTORS,
  QUORUM_VECTORS,
  canonicalStringify,
  hmacHex,
  HEX_KEY,
  ID_HEX_KEY,
  NOW_MS,
  TRUSTED_ISSUERS,
  TRUSTED_IDENTITY_ISSUERS,
  type ApprovalArtifactV1,
  type ApprovalQuorumV1,
  type IdentityAssertionV1,
  type QuorumVector,
  type SingleOutcomeVector,
  type ReplayOutcomeVector,
  type Vector,
} from "../../contract/tools/gen_approval_artifact_vectors.mjs";

const VECTORS_DIR = resolve(__dirname, "..", "..", "contract", "vectors", "approval-artifact");
const SCHEMA_PATH = resolve(__dirname, "..", "..", "contract", "schemas", "approval-artifact.schema.json");

// ── 1. Generator drift ────────────────────────────────────────────────

describe("approval-artifact vectors: generator drift", () => {
  it("on-disk fixtures match generator output byte-for-byte", () => {
    const onDisk = readdirSync(VECTORS_DIR).filter((f) => f.endsWith(".json")).sort();
    const inMem = VECTORS.map((v) => `${v.name}.json`).sort();
    expect(onDisk).toEqual(inMem);
    for (const v of VECTORS) {
      const path = resolve(VECTORS_DIR, `${v.name}.json`);
      const stored = readFileSync(path, "utf8");
      const regenerated = JSON.stringify(v, null, 2) + "\n";
      expect(stored).toBe(regenerated);
    }
  });
});

// ── 2. Schema drift ───────────────────────────────────────────────────

interface JsonSchemaProperty {
  type?: string | string[];
  const?: string;
  enum?: string[];
  pattern?: string;
}
interface JsonSchema {
  type: string;
  required: string[];
  properties: Record<string, JsonSchemaProperty & { properties?: Record<string, JsonSchemaProperty>; required?: string[] }>;
}

function loadSchema(): JsonSchema {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

function checkPrimitive(value: unknown, prop: JsonSchemaProperty, path: string): string | null {
  if (prop.const !== undefined && value !== prop.const) {
    return `${path}: expected const ${JSON.stringify(prop.const)}, got ${JSON.stringify(value)}`;
  }
  if (prop.enum && !prop.enum.includes(String(value))) {
    return `${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(prop.enum)}`;
  }
  if (prop.pattern && typeof value === "string" && !new RegExp(prop.pattern).test(value)) {
    return `${path}: ${JSON.stringify(value)} does not match ${prop.pattern}`;
  }
  if (typeof prop.type === "string") {
    if (prop.type === "string" && typeof value !== "string") return `${path}: expected string`;
    if (prop.type === "array" && !Array.isArray(value)) return `${path}: expected array`;
    if (prop.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) {
      return `${path}: expected object`;
    }
  }
  return null;
}

function validateAgainstSchema(artifact: Record<string, unknown>, schema: JsonSchema): string[] {
  const errors: string[] = [];
  for (const req of schema.required) {
    if (!(req in artifact)) errors.push(`missing required: ${req}`);
  }
  for (const [key, prop] of Object.entries(schema.properties)) {
    if (!(key in artifact)) continue;
    const v = artifact[key];
    const err = checkPrimitive(v, prop, key);
    if (err) errors.push(err);
    if (prop.type === "object" && prop.required && v && typeof v === "object") {
      for (const sub of prop.required) {
        if (!(sub in (v as Record<string, unknown>))) errors.push(`missing required: ${key}.${sub}`);
      }
      if (prop.properties) {
        for (const [subKey, subProp] of Object.entries(prop.properties)) {
          if (!(subKey in (v as Record<string, unknown>))) continue;
          const subErr = checkPrimitive((v as Record<string, unknown>)[subKey], subProp, `${key}.${subKey}`);
          if (subErr) errors.push(subErr);
        }
      }
    }
  }
  return errors;
}

describe("approval-artifact vectors: schema drift", () => {
  const schema = loadSchema();

  for (const v of VECTORS) {
    it(`fixture "${v.name}" satisfies schema's required fields + types`, () => {
      // wrong-signature mutates action_type after signing — the schema
      // doesn't constrain action_type beyond min/max length and string,
      // so the fixture is still schema-valid. This is the *contract*
      // we want: the schema describes structure, the verifier
      // describes integrity.
      const errors = validateAgainstSchema(v.artifact as unknown as Record<string, unknown>, schema);
      expect(errors).toEqual([]);
    });
  }
});

// ── 3. Verifier drift ─────────────────────────────────────────────────
//
// In-process mirror of the Deno verifier (atlasent-console +
// atlasent-api _shared/approval_artifact.ts). Order of checks must
// match exactly so the same fixture produces the same first-failure
// reason in all three implementations.

type Artifact = ApprovalArtifactV1;

type IdentityIssuerEntry = {
  alg: "HS256" | "Ed25519";
  key: string;
  allowed_roles?: string[];
  allowed_environments?: string[];
};

function lookupIdentityIssuer(
  cfg: Record<string, Record<string, IdentityIssuerEntry>>,
  issuerId: string,
  kid: string,
): IdentityIssuerEntry | null {
  return cfg[issuerId]?.[kid] ?? null;
}

function canonicalAssertionPayload(a: IdentityAssertionV1): string {
  const { signature: _omit, ...rest } = a;
  return canonicalStringify(rest);
}

function verifyIdentityHmac(
  payload: string,
  signature: string,
  hexKey: string,
): boolean {
  const expected = createHmac("sha256", Buffer.from(hexKey, "hex"))
    .update(payload, "utf8")
    .digest("hex");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.toLowerCase().charCodeAt(i);
  }
  return diff === 0;
}

type IdentityVerifyInputs = {
  required: boolean;
  expectedReviewerId: string;
  expectedTenantId: string;
  expectedActionHash: string;
  expectedApprovalId: string;
  expectedRole: string;
  expectedEnvironment: string;
};

function mirrorVerifyIdentity(
  assertion: IdentityAssertionV1 | undefined,
  expected: IdentityVerifyInputs,
  trusted: Record<string, Record<string, IdentityIssuerEntry>>,
  nowMs: number,
): { ok: true; identity_issuer_id: string; identity_kid: string } | { ok: false; reason: string } {
  if (!assertion) {
    if (expected.required) return { ok: false, reason: "missing identity assertion" };
    return { ok: true, identity_issuer_id: "", identity_kid: "" };
  }
  if (assertion.version !== "identity_assertion.v1") {
    return { ok: false, reason: "invalid identity assertion version" };
  }
  if (assertion.binding?.tenant_id !== expected.expectedTenantId) {
    return { ok: false, reason: "identity assertion tenant mismatch" };
  }
  if (assertion.binding?.action_hash !== expected.expectedActionHash) {
    return { ok: false, reason: "identity assertion does not match this action" };
  }
  if (assertion.subject?.principal_kind !== "human") {
    return { ok: false, reason: "identity assertion subject must be human" };
  }
  if (assertion.subject?.principal_id !== expected.expectedReviewerId) {
    return { ok: false, reason: "identity assertion subject does not match reviewer" };
  }
  if (assertion.binding?.approval_id !== expected.expectedApprovalId) {
    return { ok: false, reason: "identity assertion does not match this approval" };
  }
  if (assertion.role !== expected.expectedRole) {
    return { ok: false, reason: "identity assertion role does not match required role" };
  }
  if (assertion.binding?.environment !== expected.expectedEnvironment) {
    return { ok: false, reason: "identity assertion environment mismatch" };
  }
  const entry = lookupIdentityIssuer(trusted, assertion.issuer.issuer_id, assertion.issuer.kid);
  if (!entry) return { ok: false, reason: "untrusted identity issuer" };
  if (entry.allowed_roles && entry.allowed_roles.length > 0 && !entry.allowed_roles.includes(assertion.role)) {
    return { ok: false, reason: "identity issuer not authorized for this role" };
  }
  if (
    entry.allowed_environments &&
    entry.allowed_environments.length > 0 &&
    !entry.allowed_environments.includes(assertion.binding.environment)
  ) {
    return { ok: false, reason: "identity issuer not authorized for this environment" };
  }
  const expiresAt = Date.parse(assertion.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
    return { ok: false, reason: "identity assertion expired" };
  }
  const issuedAt = Date.parse(assertion.issued_at);
  if (!Number.isFinite(issuedAt) || issuedAt > nowMs + 5 * 60_000) {
    return { ok: false, reason: "identity assertion issued in the future" };
  }
  if (entry.alg !== "HS256") return { ok: false, reason: "invalid identity assertion signature" };
  if (!verifyIdentityHmac(canonicalAssertionPayload(assertion), assertion.signature, entry.key)) {
    return { ok: false, reason: "invalid identity assertion signature" };
  }
  return {
    ok: true,
    identity_issuer_id: assertion.issuer.issuer_id,
    identity_kid: assertion.issuer.kid,
  };
}
type IssuerEntry = {
  alg: "HS256" | "Ed25519";
  key: string;
  allowed_action_types?: string[];
  allowed_environments?: string[];
  required_role?: string;
};
type VerifyInputs = {
  expectedActionHash: string;
  expectedTenantId: string;
  requiredRole: string;
  expectedEnvironment?: string;
  requireIdentityAssertion?: boolean;
};

function lookupIssuer(
  cfg: Record<string, Record<string, IssuerEntry>>,
  issuerId: string,
  kid: string,
): IssuerEntry | null {
  return cfg[issuerId]?.[kid] ?? null;
}

function isActionTypeAllowed(actionType: string, allowed: string[]): boolean {
  for (const e of allowed) {
    if (e === actionType) return true;
    if (e.endsWith(".*")) {
      const prefix = e.slice(0, -2);
      if (actionType === prefix || actionType.startsWith(prefix + ".")) return true;
    }
  }
  return false;
}

function canonicalSigningPayload(a: Artifact): string {
  const { signature: _omit, ...rest } = a;
  return canonicalStringify(rest);
}

function verifyHmac(payload: string, signature: string, hexKey: string): boolean {
  const expected = createHmac("sha256", Buffer.from(hexKey, "hex"))
    .update(payload, "utf8")
    .digest("hex");
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.toLowerCase().charCodeAt(i);
  }
  return diff === 0;
}

function mirrorVerify(
  artifact: Artifact,
  expected: VerifyInputs,
  trusted: Record<string, Record<string, IssuerEntry>>,
  nowMs: number,
  usedNonces: Set<string>,
): { ok: true; approval_id: string; reviewer_id: string } | { ok: false; reason: string } {
  if (!artifact || typeof artifact !== "object") return { ok: false, reason: "missing approval artifact" };
  if (artifact.version !== "approval_artifact.v1") return { ok: false, reason: "invalid approval artifact version" };
  if (artifact.tenant_id !== expected.expectedTenantId) return { ok: false, reason: "approval tenant mismatch" };
  if (artifact.action_hash !== expected.expectedActionHash) return { ok: false, reason: "approval does not match this action" };
  if (artifact.reviewer?.principal_kind !== "human") return { ok: false, reason: "reviewer must be human" };
  const issuerEntry = lookupIssuer(trusted, artifact.issuer.issuer_id, artifact.issuer.kid);
  if (!issuerEntry) return { ok: false, reason: "untrusted approval issuer" };
  const effectiveRole = issuerEntry.required_role ?? expected.requiredRole;
  const roles = artifact.reviewer.roles ?? [];
  if (!roles.includes(effectiveRole)) return { ok: false, reason: "reviewer lacks required role" };
  if (issuerEntry.allowed_action_types && issuerEntry.allowed_action_types.length > 0) {
    if (!isActionTypeAllowed(artifact.action_type, issuerEntry.allowed_action_types)) {
      return { ok: false, reason: "issuer not authorized for this action type" };
    }
  }
  if (issuerEntry.allowed_environments && issuerEntry.allowed_environments.length > 0) {
    if (expected.expectedEnvironment !== undefined && !issuerEntry.allowed_environments.includes(expected.expectedEnvironment)) {
      return { ok: false, reason: "issuer not authorized for this environment" };
    }
  }
  const expiresAt = Date.parse(artifact.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) return { ok: false, reason: "approval expired" };
  const issuedAt = Date.parse(artifact.issued_at);
  if (!Number.isFinite(issuedAt) || issuedAt > nowMs + 5 * 60_000) return { ok: false, reason: "approval issued in the future" };
  if (issuerEntry.alg !== "HS256") return { ok: false, reason: "invalid approval signature" };
  const signatureValid = verifyHmac(canonicalSigningPayload(artifact), artifact.signature, issuerEntry.key);
  if (!signatureValid) return { ok: false, reason: "invalid approval signature" };
  // Identity attestation runs BEFORE nonce consumption — a deny here
  // must not burn the artifact's replay protection.
  const idResult = mirrorVerifyIdentity(
    artifact.identity_assertion,
    {
      required: !!expected.requireIdentityAssertion,
      expectedReviewerId: artifact.reviewer.principal_id,
      expectedTenantId: expected.expectedTenantId,
      expectedActionHash: expected.expectedActionHash,
      expectedApprovalId: artifact.approval_id,
      expectedRole: effectiveRole,
      expectedEnvironment: expected.expectedEnvironment ?? "",
    },
    TRUSTED_IDENTITY_ISSUERS as Record<string, Record<string, IdentityIssuerEntry>>,
    nowMs,
  );
  if (!idResult.ok) return { ok: false, reason: idResult.reason };
  if (usedNonces.has(artifact.nonce)) return { ok: false, reason: "approval replay detected" };
  usedNonces.add(artifact.nonce);
  return { ok: true, approval_id: artifact.approval_id, reviewer_id: artifact.reviewer.principal_id };
}

function isReplayVector(v: Vector): v is ReplayOutcomeVector { return v.name === "replay"; }

describe("approval-artifact vectors: verifier drift", () => {
  for (const v of VECTORS as Vector[]) {
    if (isReplayVector(v)) continue;
    const single = v as SingleOutcomeVector;
    it(`fixture "${single.name}" → ${JSON.stringify(single.expected_outcome)}`, () => {
      const used = new Set<string>();
      const result = mirrorVerify(
        single.artifact,
        {
          expectedActionHash: single.inputs.expected_action_hash,
          expectedTenantId: single.inputs.expected_tenant_id,
          requiredRole: single.inputs.required_role,
          expectedEnvironment: single.inputs.expected_environment,
          requireIdentityAssertion: single.inputs.require_identity_assertion ?? false,
        },
        TRUSTED_ISSUERS as Record<string, Record<string, IssuerEntry>>,
        NOW_MS,
        used,
      );
      expect(result).toEqual(single.expected_outcome);
    });
  }

  it("replay: first verify succeeds, second is rejected by the nonce ledger", () => {
    const replay = (VECTORS as Vector[]).find(isReplayVector)!;
    const inputs: VerifyInputs = {
      expectedActionHash: replay.inputs.expected_action_hash,
      expectedTenantId: replay.inputs.expected_tenant_id,
      requiredRole: replay.inputs.required_role,
      expectedEnvironment: replay.inputs.expected_environment,
    };
    const used = new Set<string>();
    const r1 = mirrorVerify(replay.artifact, inputs, TRUSTED_ISSUERS as Record<string, Record<string, IssuerEntry>>, NOW_MS, used);
    expect(r1).toEqual(replay.expected_outcome.first);
    const r2 = mirrorVerify(replay.artifact, inputs, TRUSTED_ISSUERS as Record<string, Record<string, IssuerEntry>>, NOW_MS, used);
    expect(r2).toEqual(replay.expected_outcome.second);
  });
});

// ── 4. Sanity: HMAC matches the generator's declared key ──────────────

describe("approval-artifact vectors: signature integrity sanity check", () => {
  it("the test HEX_KEY produces signatures that match the canonical bytes for the valid fixture", () => {
    const valid = (VECTORS as Vector[]).find((v) => v.name === "valid")!;
    const { signature, ...rest } = valid.artifact;
    const expected = hmacHex(canonicalStringify(rest), HEX_KEY);
    expect(signature).toBe(expected);
    expect(createHash("sha256").digest("hex")).toHaveLength(64); // sanity that the runtime hash works
  });
});

// ── Quorum vectors ───────────────────────────────────────────────────
//
// Mirror of the Deno verifier's quorum logic. Every counted approval
// passes the existing single-approval mirror first; quorum-level
// policy is then evaluated. Drift in any layer (single-approval
// algorithm, quorum policy ordering, fixture generator, schema)
// fails the corresponding vector here.

const QUORUM_VECTORS_DIR = resolve(__dirname, "..", "..", "contract", "vectors", "approval-quorum");

describe("approval-quorum vectors: generator drift", () => {
  it("on-disk quorum fixtures match generator output byte-for-byte", () => {
    const onDisk = readdirSync(QUORUM_VECTORS_DIR).filter((f) => f.endsWith(".json")).sort();
    const inMem = QUORUM_VECTORS.map((v) => `${v.name}.json`).sort();
    expect(onDisk).toEqual(inMem);
    for (const v of QUORUM_VECTORS) {
      const path = resolve(QUORUM_VECTORS_DIR, `${v.name}.json`);
      const stored = readFileSync(path, "utf8");
      const regenerated = JSON.stringify(v, null, 2) + "\n";
      expect(stored).toBe(regenerated);
    }
  });
});

function mirrorVerifyQuorum(
  q: ApprovalQuorumV1,
  expected: { expectedActionHash: string; expectedTenantId: string; requiredRole: string; expectedEnvironment: string },
  trusted: Record<string, Record<string, IssuerEntry>>,
  trustedIdentity: Record<string, Record<string, IdentityIssuerEntry>>,
  nowMs: number,
): { ok: true; count: number; verified: Array<{ approval_id: string; reviewer_id: string; reviewer_roles: string[]; approval_issuer_id: string; identity_issuer_id: string; }> } | { ok: false; reason: string } {
  if (!q || typeof q !== "object") return { ok: false, reason: "missing approval quorum" };
  if (q.version !== "approval_quorum.v1") return { ok: false, reason: "invalid approval quorum version" };
  if (q.tenant_id !== expected.expectedTenantId) return { ok: false, reason: "approval quorum tenant mismatch" };
  if (q.action_hash !== expected.expectedActionHash) return { ok: false, reason: "approval quorum action mismatch" };
  if (q.environment !== expected.expectedEnvironment) return { ok: false, reason: "approval quorum environment mismatch" };
  if (q.policy.max_age_seconds && q.policy.max_age_seconds > 0) {
    const issuedAt = Date.parse(q.issued_at);
    if (!Number.isFinite(issuedAt) || issuedAt + q.policy.max_age_seconds * 1000 <= nowMs) {
      return { ok: false, reason: "approval quorum expired" };
    }
  }
  const approvals = Array.isArray(q.approvals) ? q.approvals : [];
  if (approvals.length === 0) return { ok: false, reason: "approval quorum empty" };
  if (approvals.length < q.policy.required_count) {
    return { ok: false, reason: "approval quorum required count not met" };
  }
  const verified: Array<{ approval_id: string; reviewer_id: string; reviewer_roles: string[]; approval_issuer_id: string; identity_issuer_id: string }> = [];
  for (let i = 0; i < approvals.length; i++) {
    const a = approvals[i] as ApprovalArtifactV1;
    if (a.tenant_id !== q.tenant_id) {
      return { ok: false, reason: `approval quorum entry ${i}: tenant mismatch within package` };
    }
    if (a.action_hash !== q.action_hash) {
      return { ok: false, reason: `approval quorum entry ${i}: action_hash mismatch within package` };
    }
    const used = new Set<string>();
    const r = mirrorVerify(a, {
      expectedActionHash: expected.expectedActionHash,
      expectedTenantId: expected.expectedTenantId,
      requiredRole: expected.requiredRole,
      expectedEnvironment: expected.expectedEnvironment,
      requireIdentityAssertion: true,
    }, trusted, nowMs, used);
    if (!r.ok) {
      return { ok: false, reason: `approval quorum entry ${i}: ${r.reason}` };
    }
    verified.push({
      approval_id: r.approval_id,
      reviewer_id: r.reviewer_id,
      reviewer_roles: a.reviewer.roles ?? [],
      approval_issuer_id: a.issuer.issuer_id,
      identity_issuer_id: a.identity_assertion?.issuer.issuer_id ?? "",
    });
  }
  // Duplicate principal_id is always rejected.
  const seenPrincipals = new Set<string>();
  for (const v of verified) {
    if (seenPrincipals.has(v.reviewer_id)) {
      return { ok: false, reason: "approval quorum duplicate reviewer" };
    }
    seenPrincipals.add(v.reviewer_id);
  }
  const indep = q.policy.independence ?? {};
  if (indep.distinct_approval_issuers) {
    const seen = new Set<string>();
    for (const v of verified) {
      if (seen.has(v.approval_issuer_id)) {
        return { ok: false, reason: "approval quorum independence violated: duplicate approval issuer" };
      }
      seen.add(v.approval_issuer_id);
    }
  }
  if (indep.distinct_identity_issuers) {
    const seen = new Set<string>();
    for (const v of verified) {
      if (seen.has(v.identity_issuer_id)) {
        return { ok: false, reason: "approval quorum independence violated: duplicate identity issuer" };
      }
      seen.add(v.identity_issuer_id);
    }
  }
  for (const req of q.policy.required_role_mix ?? []) {
    let count = 0;
    for (const v of verified) {
      if (v.reviewer_roles.includes(req.role)) count++;
    }
    if (count < req.min) {
      return {
        ok: false,
        reason: `approval quorum role mix not satisfied: need ${req.min} of role '${req.role}', got ${count}`,
      };
    }
  }
  return { ok: true, count: verified.length, verified };
}

describe("approval-quorum vectors: verifier drift", () => {
  for (const v of QUORUM_VECTORS as QuorumVector[]) {
    it(`fixture "${v.name}" → ${JSON.stringify(v.expected_outcome)}`, () => {
      const result = mirrorVerifyQuorum(
        v.package,
        {
          expectedActionHash: v.inputs.expected_action_hash,
          expectedTenantId: v.inputs.expected_tenant_id,
          requiredRole: v.inputs.required_role,
          expectedEnvironment: v.inputs.expected_environment,
        },
        TRUSTED_ISSUERS as Record<string, Record<string, IssuerEntry>>,
        TRUSTED_IDENTITY_ISSUERS as Record<string, Record<string, IdentityIssuerEntry>>,
        NOW_MS,
      );
      if (v.expected_outcome.ok) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.count).toBe(v.expected_outcome.count);
      } else {
        expect(result).toEqual(v.expected_outcome);
      }
    });
  }
});
