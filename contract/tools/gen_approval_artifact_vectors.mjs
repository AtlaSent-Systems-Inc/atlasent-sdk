#!/usr/bin/env node
// Generate test vectors for approval_artifact.v1.
//
// Output: contract/vectors/approval-artifact/<name>.json — one file per
// scenario, self-describing the verifier inputs (trusted-issuer config,
// expected_action_hash, expected_tenant_id, required_role, the now()
// instant the test pins) and the expected verifier outcome.
//
// The vitest drift test in atlasent-sdk/typescript/test/
// approval-artifact-vectors.test.ts:
//   1. Re-runs this generator in-memory and asserts the on-disk
//      fixtures match — catches accidental edits.
//   2. Validates each fixture's `artifact` against the JSON Schema in
//      contract/schemas/approval-artifact.schema.json — catches drift
//      between fixtures and schema.
//   3. Runs each fixture through a TS mirror of the verifier and
//      asserts the outcome matches the fixture's expected_outcome —
//      catches drift between schema, fixtures, and verifier.
//
// Run: `node contract/tools/gen_approval_artifact_vectors.mjs`

import { createHmac } from "node:crypto";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const VECTORS_DIR = resolve(REPO_ROOT, "contract", "vectors", "approval-artifact");

// Pinned test inputs — keep stable across regenerations.
const NOW_ISO = "2026-04-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const HEX_KEY = "5".repeat(64); // shared HS256 secret for the test issuer
const TENANT_ID = "tnt_test";
const ACTOR_ID = "agent_test_1";
const RESOURCE_ID = "release:abc123";
const ACTION_TYPE = "deployment.production.deploy";
const ENVIRONMENT = "production";
const POLICY_VERSION = "bundle-hash-v1";
const REQUIRED_ROLE = "qa_reviewer";

const TRUSTED_ISSUERS = {
  "issuer.qa": {
    "kid-1": { alg: "HS256", key: HEX_KEY },
  },
};

// Independent trust root for the identity-assertion verifier.
const ID_HEX_KEY = "9".repeat(64);
const TRUSTED_IDENTITY_ISSUERS = {
  "idp.test": {
    "kid-id-1": { alg: "HS256", key: ID_HEX_KEY },
  },
};

// ── Canonical stringify (must match the verifier byte-for-byte) ──────
function canonicalStringify(obj) {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "bigint") throw new Error("BigInt not allowed");
  if (typeof obj === "number") {
    if (!Number.isFinite(obj)) throw new Error("NaN/Infinity not allowed");
    return JSON.stringify(obj);
  }
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (obj instanceof Date) throw new Error("Date not allowed");
  if (Array.isArray(obj)) return "[" + obj.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(obj[k])).join(",") + "}";
}

function sha256Hex(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function hmacHex(payload, hexKey) {
  return createHmac("sha256", Buffer.from(hexKey, "hex")).update(payload, "utf8").digest("hex");
}

// ── Canonical action hash (must match verifier; binds env+policy_version) ──
function actionHash({ action_type, actor_id, resource_id, amount, context, environment, policy_version }) {
  return sha256Hex(canonicalStringify({
    action_type,
    actor_id,
    resource_id,
    amount: amount ?? null,
    context: context ?? {},
    environment: environment ?? null,
    policy_version: policy_version ?? null,
  }));
}

const VALID_ACTION_HASH = actionHash({
  action_type: ACTION_TYPE,
  actor_id: ACTOR_ID,
  resource_id: RESOURCE_ID,
  context: { tenant_id: TENANT_ID },
  environment: ENVIRONMENT,
  policy_version: POLICY_VERSION,
});

function makeIdentityAssertion(artifact, overrides = {}) {
  const a = {
    version: "identity_assertion.v1",
    subject: {
      principal_id: artifact.reviewer.principal_id,
      principal_kind: "human",
    },
    role: REQUIRED_ROLE,
    binding: {
      approval_id: artifact.approval_id,
      action_hash: artifact.action_hash,
      tenant_id: artifact.tenant_id,
      environment: ENVIRONMENT,
    },
    issuer: { type: "oidc", issuer_id: "idp.test", kid: "kid-id-1" },
    issued_at: new Date(NOW_MS - 30_000).toISOString(),
    expires_at: new Date(NOW_MS + 30 * 60_000).toISOString(),
    signature: "",
    ...overrides,
  };
  if (overrides.signature !== undefined) {
    a.signature = overrides.signature;
  } else {
    const { signature: _omit, ...rest } = a;
    a.signature = hmacHex(canonicalStringify(rest), ID_HEX_KEY);
  }
  return a;
}

function makeArtifact(overrides = {}) {
  const issuedAt = new Date(NOW_MS - 60_000).toISOString();
  const expiresAt = new Date(NOW_MS + 60 * 60_000).toISOString();
  const a = {
    version: "approval_artifact.v1",
    approval_id: "apr_fixture_1",
    tenant_id: TENANT_ID,
    action_type: ACTION_TYPE,
    resource_id: RESOURCE_ID,
    action_hash: VALID_ACTION_HASH,
    reviewer: {
      principal_id: "okta|00u_test_alice",
      principal_kind: "human",
      email: "alice@example.com",
      roles: [REQUIRED_ROLE],
    },
    issuer: { type: "approval_service", issuer_id: "issuer.qa", kid: "kid-1" },
    issued_at: issuedAt,
    expires_at: expiresAt,
    nonce: "n_fixture_0001",
    signature: "",
    ...overrides,
  };
  // Sign last so all overrides are reflected in the canonical bytes.
  const { signature: existing, ...rest } = a;
  if (overrides.signature !== undefined) {
    a.signature = overrides.signature;
  } else {
    a.signature = hmacHex(canonicalStringify(rest), HEX_KEY);
  }
  return a;
}

// ── Vector definitions ───────────────────────────────────────────────

const baseVerifierInputs = () => ({
  trusted_issuers: TRUSTED_ISSUERS,
  trusted_identity_issuers: TRUSTED_IDENTITY_ISSUERS,
  expected_action_hash: VALID_ACTION_HASH,
  expected_tenant_id: TENANT_ID,
  required_role: REQUIRED_ROLE,
  expected_environment: ENVIRONMENT,
  now_iso: NOW_ISO,
  hs256_test_key_hex: HEX_KEY,
  hs256_identity_test_key_hex: ID_HEX_KEY,
});

function attachIdentityAssertion(artifact, identityOverrides = {}) {
  // Build the assertion against the artifact's identity, then resign
  // the artifact so the canonical bytes include identity_assertion.
  artifact.identity_assertion = makeIdentityAssertion(artifact, identityOverrides);
  const { signature: _omit, ...rest } = artifact;
  artifact.signature = hmacHex(canonicalStringify(rest), HEX_KEY);
  return artifact;
}

// ── Quorum helpers ────────────────────────────────────────────────────
//
// A quorum-friendly artifact: distinct approval_id, nonce, reviewer
// principal_id per entry. Identity assertion attached, artifact
// resigned. Everything else parametric.

function makeQuorumArtifact({
  approval_id,
  principal_id,
  approval_issuer = { type: "approval_service", issuer_id: "issuer.qa", kid: "kid-1" },
  identity_overrides = {},
  reviewer_overrides = {},
}) {
  const base = makeArtifact({
    approval_id,
    nonce: `n_${approval_id}`,
    issuer: approval_issuer,
    reviewer: {
      principal_id,
      principal_kind: "human",
      roles: [REQUIRED_ROLE],
      ...reviewer_overrides,
    },
  });
  attachIdentityAssertion(base, identity_overrides);
  return base;
}

function makeQuorumPackage({
  approvals,
  policyOverrides = {},
  packageOverrides = {},
} = {}) {
  return {
    version: "approval_quorum.v1",
    tenant_id: TENANT_ID,
    action_hash: VALID_ACTION_HASH,
    environment: ENVIRONMENT,
    issued_at: new Date(NOW_MS - 5_000).toISOString(),
    policy: { required_count: approvals.length, ...policyOverrides },
    approvals,
    ...packageOverrides,
  };
}

const VECTORS = [
  {
    name: "valid",
    description: "All checks pass: human reviewer, trusted issuer, correct action hash, in-window expiry, fresh nonce, valid HMAC signature.",
    expected_outcome: { ok: true, approval_id: "apr_fixture_1", reviewer_id: "okta|00u_test_alice" },
    inputs: baseVerifierInputs(),
    artifact: makeArtifact({ approval_id: "apr_fixture_1", nonce: "n_fixture_valid" }),
  },
  {
    name: "expired",
    description: "expires_at is in the past relative to now_iso; verifier must return reason='approval expired'.",
    expected_outcome: { ok: false, reason: "approval expired" },
    inputs: baseVerifierInputs(),
    artifact: makeArtifact({
      approval_id: "apr_fixture_expired",
      nonce: "n_fixture_expired",
      issued_at: new Date(NOW_MS - 10 * 60_000).toISOString(),
      expires_at: new Date(NOW_MS - 1_000).toISOString(),
    }),
  },
  {
    name: "wrong-hash",
    description: "action_hash does not match the verifier's expected hash; verifier must return reason='approval does not match this action'.",
    expected_outcome: { ok: false, reason: "approval does not match this action" },
    inputs: baseVerifierInputs(),
    artifact: makeArtifact({
      approval_id: "apr_fixture_wrong_hash",
      nonce: "n_fixture_wrong_hash",
      action_hash: "0".repeat(64),
    }),
  },
  {
    name: "agent-reviewer",
    description: "reviewer.principal_kind = 'agent' — the verifier must reject regardless of role; reason='reviewer must be human'.",
    expected_outcome: { ok: false, reason: "reviewer must be human" },
    inputs: baseVerifierInputs(),
    artifact: makeArtifact({
      approval_id: "apr_fixture_agent",
      nonce: "n_fixture_agent",
      reviewer: { principal_id: "agent_99", principal_kind: "agent", roles: [REQUIRED_ROLE] },
    }),
  },
  {
    name: "untrusted-issuer",
    description: "issuer_id is not in trusted_issuers; reason='untrusted approval issuer'.",
    expected_outcome: { ok: false, reason: "untrusted approval issuer" },
    inputs: baseVerifierInputs(),
    artifact: makeArtifact({
      approval_id: "apr_fixture_untrusted",
      nonce: "n_fixture_untrusted",
      issuer: { type: "approval_service", issuer_id: "issuer.unknown", kid: "kid-x" },
    }),
  },
  {
    name: "wrong-signature",
    description: "Artifact body tampered after signing (action_type changed) — HMAC no longer matches; reason='invalid approval signature'.",
    expected_outcome: { ok: false, reason: "invalid approval signature" },
    inputs: baseVerifierInputs(),
    artifact: (() => {
      const a = makeArtifact({ approval_id: "apr_fixture_tampered", nonce: "n_fixture_tampered" });
      a.action_type = ACTION_TYPE + ".tampered"; // breaks HMAC
      return a;
    })(),
  },
  {
    name: "replay",
    description: "Same artifact as valid — used twice in sequence. First verify must succeed; second must return reason='approval replay detected'. Test exercises the nonce ledger; this fixture is the *artifact*, not the outcome.",
    expected_outcome: {
      first: { ok: true, approval_id: "apr_fixture_replay", reviewer_id: "okta|00u_test_alice" },
      second: { ok: false, reason: "approval replay detected" },
    },
    inputs: baseVerifierInputs(),
    artifact: makeArtifact({ approval_id: "apr_fixture_replay", nonce: "n_fixture_replay" }),
  },
  {
    name: "missing-role",
    description: "Reviewer is human but lacks the required role; reason='reviewer lacks required role'.",
    expected_outcome: { ok: false, reason: "reviewer lacks required role" },
    inputs: baseVerifierInputs(),
    artifact: makeArtifact({
      approval_id: "apr_fixture_missing_role",
      nonce: "n_fixture_missing_role",
      reviewer: {
        principal_id: "okta|00u_test_bob",
        principal_kind: "human",
        roles: ["viewer"], // not qa_reviewer
      },
    }),
  },

  // ── Identity-assertion fixtures ─────────────────────────────────
  //
  // These fixtures all carry require_identity_assertion=true on the
  // verifier inputs. The "id-valid" case adds a correctly-signed
  // assertion; every "id-*" failure case is the same artifact +
  // assertion mutated to fire exactly one identity-side check.

  (() => {
    const a = makeArtifact({ approval_id: "apr_fixture_id_valid", nonce: "n_fixture_id_valid" });
    attachIdentityAssertion(a);
    return {
      name: "id-valid",
      description: "Approval artifact + verifiable identity assertion. Verifier requires identity assertion; both signatures + all bindings pass.",
      expected_outcome: {
        ok: true,
        approval_id: "apr_fixture_id_valid",
        reviewer_id: "okta|00u_test_alice",
      },
      inputs: { ...baseVerifierInputs(), require_identity_assertion: true },
      artifact: a,
    };
  })(),

  (() => {
    // Identity required, none attached.
    const a = makeArtifact({ approval_id: "apr_fixture_id_missing", nonce: "n_fixture_id_missing" });
    return {
      name: "id-missing",
      description: "Verifier requires identity assertion but the artifact carries none; reason='missing identity assertion'.",
      expected_outcome: { ok: false, reason: "missing identity assertion" },
      inputs: { ...baseVerifierInputs(), require_identity_assertion: true },
      artifact: a,
    };
  })(),

  (() => {
    const a = makeArtifact({ approval_id: "apr_fixture_id_expired", nonce: "n_fixture_id_expired" });
    attachIdentityAssertion(a, {
      issued_at: new Date(NOW_MS - 10 * 60_000).toISOString(),
      expires_at: new Date(NOW_MS - 1_000).toISOString(),
    });
    return {
      name: "id-expired",
      description: "Identity assertion expires_at is in the past; reason='identity assertion expired'.",
      expected_outcome: { ok: false, reason: "identity assertion expired" },
      inputs: { ...baseVerifierInputs(), require_identity_assertion: true },
      artifact: a,
    };
  })(),

  (() => {
    const a = makeArtifact({ approval_id: "apr_fixture_id_wrong_reviewer", nonce: "n_fixture_id_wrong_reviewer" });
    attachIdentityAssertion(a, {
      subject: { principal_id: "okta|someone_else", principal_kind: "human" },
    });
    return {
      name: "id-wrong-reviewer",
      description: "Identity assertion subject does not match artifact.reviewer.principal_id; reason='identity assertion subject does not match reviewer'.",
      expected_outcome: { ok: false, reason: "identity assertion subject does not match reviewer" },
      inputs: { ...baseVerifierInputs(), require_identity_assertion: true },
      artifact: a,
    };
  })(),

  (() => {
    const a = makeArtifact({ approval_id: "apr_fixture_id_wrong_role", nonce: "n_fixture_id_wrong_role" });
    attachIdentityAssertion(a, { role: "security_lead" });
    return {
      name: "id-wrong-role",
      description: "Identity assertion role differs from required_role; reason='identity assertion role does not match required role'.",
      expected_outcome: { ok: false, reason: "identity assertion role does not match required role" },
      inputs: { ...baseVerifierInputs(), require_identity_assertion: true },
      artifact: a,
    };
  })(),

  (() => {
    const a = makeArtifact({ approval_id: "apr_fixture_id_wrong_env", nonce: "n_fixture_id_wrong_env" });
    attachIdentityAssertion(a, {
      binding: {
        approval_id: a.approval_id,
        action_hash: a.action_hash,
        tenant_id: a.tenant_id,
        environment: "staging", // mismatch
      },
    });
    return {
      name: "id-wrong-environment",
      description: "Identity assertion binding.environment differs from expected_environment; reason='identity assertion environment mismatch'.",
      expected_outcome: { ok: false, reason: "identity assertion environment mismatch" },
      inputs: { ...baseVerifierInputs(), require_identity_assertion: true },
      artifact: a,
    };
  })(),

  (() => {
    const a = makeArtifact({ approval_id: "apr_fixture_id_wrong_hash", nonce: "n_fixture_id_wrong_hash" });
    attachIdentityAssertion(a, {
      binding: {
        approval_id: a.approval_id,
        action_hash: "0".repeat(64), // mismatch
        tenant_id: a.tenant_id,
        environment: ENVIRONMENT,
      },
    });
    return {
      name: "id-wrong-action-hash",
      description: "Identity assertion binding.action_hash differs from expected_action_hash; reason='identity assertion does not match this action'.",
      expected_outcome: { ok: false, reason: "identity assertion does not match this action" },
      inputs: { ...baseVerifierInputs(), require_identity_assertion: true },
      artifact: a,
    };
  })(),

  (() => {
    const a = makeArtifact({ approval_id: "apr_fixture_id_untrusted", nonce: "n_fixture_id_untrusted" });
    attachIdentityAssertion(a, {
      issuer: { type: "oidc", issuer_id: "idp.unknown", kid: "kid-x" },
    });
    return {
      name: "id-untrusted-issuer",
      description: "Identity assertion issuer not in IDENTITY_TRUSTED_ISSUERS; reason='untrusted identity issuer'.",
      expected_outcome: { ok: false, reason: "untrusted identity issuer" },
      inputs: { ...baseVerifierInputs(), require_identity_assertion: true },
      artifact: a,
    };
  })(),
];

// ── Quorum vectors ───────────────────────────────────────────────────

const QUORUM_VECTORS_DIR = resolve(REPO_ROOT, "contract", "vectors", "approval-quorum");

const baseQuorumInputs = () => ({
  trusted_issuers: TRUSTED_ISSUERS,
  trusted_identity_issuers: TRUSTED_IDENTITY_ISSUERS,
  expected_action_hash: VALID_ACTION_HASH,
  expected_tenant_id: TENANT_ID,
  required_role: REQUIRED_ROLE,
  expected_environment: ENVIRONMENT,
  now_iso: NOW_ISO,
  hs256_test_key_hex: HEX_KEY,
  hs256_identity_test_key_hex: ID_HEX_KEY,
});

// Each quorum vector includes the verifier inputs + expected outcome
// alongside the package, mirroring the artifact-vector layout. The
// reasons here are the EXACT strings the locked verifier returns.

const QUORUM_VECTORS = [
  (() => ({
    name: "q-valid-2of2",
    description: "2-of-2 quorum: distinct human reviewers, both with qa_reviewer; happy path.",
    expected_outcome: { ok: true, count: 2 },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [
        makeQuorumArtifact({ approval_id: "apr_q_alice", principal_id: "okta|alice" }),
        makeQuorumArtifact({ approval_id: "apr_q_bob",   principal_id: "okta|bob" }),
      ],
    }),
  }))(),

  (() => ({
    name: "q-required-count-not-met",
    description: "Policy demands 2 but only 1 approval submitted.",
    expected_outcome: { ok: false, reason: "approval quorum required count not met" },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [makeQuorumArtifact({ approval_id: "apr_q_solo", principal_id: "okta|alice" })],
      policyOverrides: { required_count: 2 },
    }),
  }))(),

  (() => ({
    name: "q-duplicate-reviewer",
    description: "Same human approves twice (different artifact ids); always rejected regardless of independence policy.",
    expected_outcome: { ok: false, reason: "approval quorum duplicate reviewer" },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [
        makeQuorumArtifact({ approval_id: "apr_q_dup_1", principal_id: "okta|alice" }),
        makeQuorumArtifact({ approval_id: "apr_q_dup_2", principal_id: "okta|alice" }),
      ],
    }),
  }))(),

  (() => ({
    name: "q-tenant-mismatch",
    description: "Package tenant differs from verifier's expected tenant.",
    expected_outcome: { ok: false, reason: "approval quorum tenant mismatch" },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [makeQuorumArtifact({ approval_id: "apr_q_tn", principal_id: "okta|alice" })],
      packageOverrides: { tenant_id: "tnt_other" },
    }),
  }))(),

  (() => ({
    name: "q-action-mismatch",
    description: "Package action_hash differs from verifier's expected action_hash.",
    expected_outcome: { ok: false, reason: "approval quorum action mismatch" },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [makeQuorumArtifact({ approval_id: "apr_q_act", principal_id: "okta|alice" })],
      packageOverrides: { action_hash: "0".repeat(64) },
    }),
  }))(),

  (() => ({
    name: "q-environment-mismatch",
    description: "Package environment differs from verifier's expected environment.",
    expected_outcome: { ok: false, reason: "approval quorum environment mismatch" },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [makeQuorumArtifact({ approval_id: "apr_q_env", principal_id: "okta|alice" })],
      packageOverrides: { environment: "staging" },
    }),
  }))(),

  (() => ({
    name: "q-role-mix-unsatisfied",
    description: "Policy requires ≥1 qa_reviewer AND ≥1 security_lead; only qa_reviewers present.",
    expected_outcome: {
      ok: false,
      reason: "approval quorum role mix not satisfied: need 1 of role 'security_lead', got 0",
    },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [
        makeQuorumArtifact({ approval_id: "apr_q_mix1", principal_id: "okta|alice" }),
        makeQuorumArtifact({ approval_id: "apr_q_mix2", principal_id: "okta|bob" }),
      ],
      policyOverrides: {
        required_role_mix: [
          { role: "qa_reviewer", min: 1 },
          { role: "security_lead", min: 1 },
        ],
      },
    }),
  }))(),

  (() => ({
    name: "q-role-mix-satisfied",
    description: "Two distinct reviewers; both carry the baseline qa_reviewer (required by the single-approval verifier), and one also carries security_lead so the role-mix policy is satisfied.",
    expected_outcome: { ok: true, count: 2 },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [
        makeQuorumArtifact({ approval_id: "apr_q_mixok1", principal_id: "okta|alice" }),
        makeQuorumArtifact({
          approval_id: "apr_q_mixok2",
          principal_id: "okta|bob",
          reviewer_overrides: { roles: ["qa_reviewer", "security_lead"] },
        }),
      ],
      policyOverrides: {
        required_role_mix: [
          { role: "qa_reviewer", min: 1 },
          { role: "security_lead", min: 1 },
        ],
      },
    }),
  }))(),

  (() => ({
    name: "q-distinct-approval-issuers-violated",
    description: "Policy demands distinct approval issuers; both approvals minted by issuer.qa.",
    expected_outcome: {
      ok: false,
      reason: "approval quorum independence violated: duplicate approval issuer",
    },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [
        makeQuorumArtifact({ approval_id: "apr_q_iss1", principal_id: "okta|alice" }),
        makeQuorumArtifact({ approval_id: "apr_q_iss2", principal_id: "okta|bob" }),
      ],
      policyOverrides: { independence: { distinct_approval_issuers: true } },
    }),
  }))(),

  (() => ({
    name: "q-entry-bad-identity",
    description: "Second entry's identity assertion is removed; quorum denies with the underlying single-approval reason.",
    expected_outcome: { ok: false, reason: "approval quorum entry 1: missing identity assertion" },
    inputs: baseQuorumInputs(),
    package: (() => {
      const a1 = makeQuorumArtifact({ approval_id: "apr_q_id1", principal_id: "okta|alice" });
      const a2 = makeQuorumArtifact({ approval_id: "apr_q_id2", principal_id: "okta|bob" });
      // Strip the assertion AND resign so the artifact's signature
      // remains valid against the modified canonical bytes — the
      // failure reason must come from the missing-identity gate,
      // not from a stale signature.
      delete a2.identity_assertion;
      const { signature: _omit, ...rest } = a2;
      a2.signature = hmacHex(canonicalStringify(rest), HEX_KEY);
      return makeQuorumPackage({ approvals: [a1, a2] });
    })(),
  }))(),

  (() => ({
    name: "q-package-stale",
    description: "Package issued_at + max_age_seconds is in the past relative to now_iso.",
    expected_outcome: { ok: false, reason: "approval quorum expired" },
    inputs: baseQuorumInputs(),
    package: makeQuorumPackage({
      approvals: [
        makeQuorumArtifact({ approval_id: "apr_q_st1", principal_id: "okta|alice" }),
        makeQuorumArtifact({ approval_id: "apr_q_st2", principal_id: "okta|bob" }),
      ],
      packageOverrides: { issued_at: new Date(NOW_MS - 10 * 60_000).toISOString() },
      policyOverrides: { max_age_seconds: 60 },
    }),
  }))(),
];

// ── Write fixtures ───────────────────────────────────────────────────

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("gen_approval_artifact_vectors.mjs")) {
  mkdirSync(VECTORS_DIR, { recursive: true });
  for (const v of VECTORS) {
    const path = resolve(VECTORS_DIR, `${v.name}.json`);
    writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
    process.stdout.write(`wrote ${path}\n`);
  }
  mkdirSync(QUORUM_VECTORS_DIR, { recursive: true });
  for (const v of QUORUM_VECTORS) {
    const path = resolve(QUORUM_VECTORS_DIR, `${v.name}.json`);
    writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
    process.stdout.write(`wrote ${path}\n`);
  }
  process.stdout.write(`generated ${VECTORS.length} approval vectors + ${QUORUM_VECTORS.length} quorum vectors\n`);
}

export {
  VECTORS,
  QUORUM_VECTORS,
  canonicalStringify,
  sha256Hex,
  hmacHex,
  actionHash,
  makeArtifact,
  makeIdentityAssertion,
  attachIdentityAssertion,
  makeQuorumArtifact,
  makeQuorumPackage,
  NOW_ISO,
  NOW_MS,
  HEX_KEY,
  ID_HEX_KEY,
  TRUSTED_ISSUERS,
  TRUSTED_IDENTITY_ISSUERS,
};
