/**
 * Type-level drift detector for the v2 Pillar 9 interfaces.
 *
 * Every required field declared in `contract/schemas/v2/*.schema.json`
 * MUST appear on the corresponding TypeScript interface. The test
 * reads the schemas at test time, collects their required-field sets,
 * and asserts that a fully-populated instance of the matching type
 * passes TypeScript's structural check with those fields present.
 *
 * The instances below are literal objects typed against the real
 * interface. If a schema gains a required field that the interface
 * does not declare, this file fails to type-check — the drift surfaces
 * before a single byte of production code lands.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type {
  ConsumeRequest,
  ConsumeResponse,
  Proof,
  ProofVerificationCheck,
  ProofVerificationResult,
} from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SCHEMAS_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "contract",
  "schemas",
  "v2",
);

function loadSchema(file: string): {
  required: string[];
  properties: Record<string, unknown>;
} {
  const raw = readFileSync(resolve(SCHEMAS_DIR, file), "utf8");
  const parsed = JSON.parse(raw);
  return {
    required: parsed.required ?? [],
    properties: parsed.properties ?? {},
  };
}

const FULL_PROOF: Proof = {
  proof_id: "550e8400-e29b-41d4-a716-446655440000",
  permit_id: "dec_abc",
  org_id: "org-1",
  agent: "deploy-bot",
  action: "deploy_to_production",
  target: "prod-cluster",
  payload_hash: "0".repeat(64),
  policy_version: "v3-a7f1",
  decision: "allow",
  execution_status: "executed",
  execution_hash: null,
  audit_hash: "a".repeat(64),
  previous_hash: "0".repeat(64),
  chain_hash: "a".repeat(64),
  signing_key_id: "key-1",
  signature: "sig_base64url",
  issued_at: "2026-04-24T12:00:00Z",
  consumed_at: "2026-04-24T12:00:01Z",
};

const FULL_CONSUME_REQUEST: ConsumeRequest = {
  permit_id: "dec_abc",
  payload_hash: "0".repeat(64),
  execution_status: "executed",
  api_key: "ask_live_test",
};

const FULL_CONSUME_RESPONSE: ConsumeResponse = {
  proof_id: "550e8400-e29b-41d4-a716-446655440000",
  execution_status: "executed",
  audit_hash: "a".repeat(64),
};

const FULL_CHECK: ProofVerificationCheck = {
  name: "signature",
  passed: true,
};

const FULL_VERIFY_RESULT: ProofVerificationResult = {
  verification_status: "valid",
  proof_id: "550e8400-e29b-41d4-a716-446655440000",
  checks: [FULL_CHECK],
};

describe("types ↔ schema parity (Proof)", () => {
  const schema = loadSchema("proof.schema.json");

  it("carries every required schema field", () => {
    const instanceKeys = Object.keys(FULL_PROOF);
    for (const req of schema.required) {
      expect(instanceKeys, `Proof missing schema-required '${req}'`).toContain(
        req,
      );
    }
  });

  it("declares no properties the schema doesn't know about", () => {
    const schemaProps = Object.keys(schema.properties);
    for (const key of Object.keys(FULL_PROOF)) {
      expect(
        schemaProps,
        `Proof declares '${key}' which isn't in the schema`,
      ).toContain(key);
    }
  });
});

describe("types ↔ schema parity (ConsumeRequest)", () => {
  const schema = loadSchema("consume-request.schema.json");

  it("carries every required schema field", () => {
    const instanceKeys = Object.keys(FULL_CONSUME_REQUEST);
    for (const req of schema.required) {
      expect(instanceKeys).toContain(req);
    }
  });
});

describe("types ↔ schema parity (ConsumeResponse)", () => {
  const schema = loadSchema("consume-response.schema.json");

  it("carries every required schema field", () => {
    const instanceKeys = Object.keys(FULL_CONSUME_RESPONSE);
    for (const req of schema.required) {
      expect(instanceKeys).toContain(req);
    }
  });
});

describe("types ↔ schema parity (ProofVerificationResult)", () => {
  const schema = loadSchema("proof-verification-result.schema.json");

  it("carries every required envelope field", () => {
    const instanceKeys = Object.keys(FULL_VERIFY_RESULT);
    for (const req of schema.required) {
      expect(instanceKeys).toContain(req);
    }
  });

  it("checks sub-object has name + passed", () => {
    expect(FULL_CHECK.name).toBe("signature");
    expect(FULL_CHECK.passed).toBe(true);
  });
});
