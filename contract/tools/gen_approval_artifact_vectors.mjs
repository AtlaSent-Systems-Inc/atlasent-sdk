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
  expected_action_hash: VALID_ACTION_HASH,
  expected_tenant_id: TENANT_ID,
  required_role: REQUIRED_ROLE,
  expected_environment: ENVIRONMENT,
  now_iso: NOW_ISO,
  hs256_test_key_hex: HEX_KEY,
});

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
];

// ── Write fixtures ───────────────────────────────────────────────────

if (typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("gen_approval_artifact_vectors.mjs")) {
  mkdirSync(VECTORS_DIR, { recursive: true });
  for (const v of VECTORS) {
    const path = resolve(VECTORS_DIR, `${v.name}.json`);
    writeFileSync(path, JSON.stringify(v, null, 2) + "\n");
    process.stdout.write(`wrote ${path}\n`);
  }
  process.stdout.write(`generated ${VECTORS.length} vectors\n`);
}

export { VECTORS, canonicalStringify, sha256Hex, hmacHex, actionHash, makeArtifact, NOW_ISO, NOW_MS, HEX_KEY, TRUSTED_ISSUERS };
