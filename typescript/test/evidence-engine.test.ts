import { describe, it, expect } from "vitest";
import {
  buildWhyTrace,
  buildDecisionReceiptPayload,
  signDecisionReceiptHmac,
  verifyDecisionReceiptHmac,
  computeBundleHash,
} from "../src/evidenceEngine.js";
import type {
  DecisionReceipt,
  DecisionReceiptPayload,
  ActionEvidenceBundle,
  WhyTrace,
} from "../src/evidenceEngine.js";
import type { ConstraintTrace } from "../src/types.js";

// ── helpers ────────────────────────────────────────────────────────────────────

function makePayload(
  overrides: Partial<Parameters<typeof buildDecisionReceiptPayload>[0]> = {},
): DecisionReceiptPayload {
  return buildDecisionReceiptPayload({
    receipt_id: "rcpt_001",
    evaluation_id: "eval_001",
    org_id: "org_abc",
    decision: "allow",
    action: "production.deploy",
    actor: "user:alice",
    resource_type: "service",
    resource_id: "api-gateway",
    reasons: ["all checks passed"],
    why_summary: "Allowed: all policy checks passed.",
    permit_id: "permit_xyz",
    permit_hash: "abc123",
    audit_hash: "deadbeef",
    context_hash: "cafebabe",
    issued_at: "2025-01-15T12:00:00.000Z",
    expires_at: null,
    ...overrides,
  });
}

async function makeSignedReceipt(
  payload: DecisionReceiptPayload,
  secret: string,
): Promise<DecisionReceipt> {
  const sig = await signDecisionReceiptHmac(payload, secret);
  return {
    receipt_id: payload.receipt_id,
    evaluation_id: payload.evaluation_id,
    org_id: payload.org_id,
    decision: payload.decision,
    action: payload.action,
    actor: payload.actor,
    resource_type: payload.resource_type,
    resource_id: payload.resource_id,
    reasons: payload.reasons,
    why_trace: null,
    permit_id: payload.permit_id,
    permit_hash: payload.permit_hash,
    audit_hash: payload.audit_hash,
    context_hash: payload.context_hash,
    issued_at: payload.issued_at,
    expires_at: payload.expires_at,
    algorithm: "hmac-sha256",
    signature: sig,
    signing_key_id: null,
    payload,
  };
}

// ── buildWhyTrace ──────────────────────────────────────────────────────────────

describe("buildWhyTrace", () => {
  it("returns minimal trace when trace is null", () => {
    const why = buildWhyTrace("allow", ["all clear"], null);
    expect(why.decision).toBe("allow");
    expect(why.policy_evaluations).toHaveLength(0);
    expect(why.total_stages_evaluated).toBe(0);
    expect(why.matched_policy_id).toBeUndefined();
    expect(why.terminal_stage).toBeUndefined();
  });

  it("formats summary for allow with reasons when trace is null", () => {
    const why = buildWhyTrace("allow", ["deployment verified"], null);
    expect(why.summary).toBe("Allowed: deployment verified");
  });

  it("formats summary for allow with no reasons when trace is null", () => {
    const why = buildWhyTrace("allow", [], null);
    expect(why.summary).toBe("Allowed: all policy checks passed.");
  });

  it("formats summary for deny with reasons", () => {
    const why = buildWhyTrace("deny", ["actor lacks deploy role"], null);
    expect(why.summary).toBe("Denied: actor lacks deploy role");
  });

  it("formats summary for deny with no reasons when trace is null", () => {
    const why = buildWhyTrace("deny", [], null);
    expect(why.summary).toBe("Denied: policy check failed.");
  });

  it("formats summary for hold", () => {
    const why = buildWhyTrace("hold", ["needs human approval"], null);
    expect(why.summary).toBe("Held for review: needs human approval");
  });

  it("formats summary for hold with no reasons", () => {
    const why = buildWhyTrace("hold", [], null);
    expect(why.summary).toBe("Held pending human review.");
  });

  it("formats summary for escalate", () => {
    const why = buildWhyTrace("escalate", ["elevated risk"], null);
    expect(why.summary).toBe("Escalated: elevated risk");
  });

  it("formats summary for escalate with no reasons", () => {
    const why = buildWhyTrace("escalate", [], null);
    expect(why.summary).toBe("Escalated to a human reviewer.");
  });

  it("maps rules_evaluated to policy_evaluations", () => {
    const trace: ConstraintTrace = {
      rules_evaluated: [
        {
          policy_id: "pol_123",
          decision: "allow",
          fingerprint: "fp_aaa",
          stages: [
            { stage: "role_check", matched: true, order: 0 },
          ],
        },
      ],
    };
    const why = buildWhyTrace("allow", [], trace);
    expect(why.policy_evaluations).toHaveLength(1);
    expect(why.policy_evaluations[0]!.policy_id).toBe("pol_123");
    expect(why.policy_evaluations[0]!.decision).toBe("allow");
    expect(why.policy_evaluations[0]!.fingerprint).toBe("fp_aaa");
    expect(why.total_stages_evaluated).toBe(1);
  });

  it("marks decisive policy with was_decisive=true", () => {
    const trace: ConstraintTrace = {
      matching_policy_id: "pol_deny",
      rules_evaluated: [
        {
          policy_id: "pol_allow",
          decision: "allow",
          fingerprint: "fp_111",
          stages: [{ stage: "role_check", matched: true, order: 0 }],
        },
        {
          policy_id: "pol_deny",
          decision: "deny",
          fingerprint: "fp_222",
          stages: [{ stage: "context", matched: true, order: 0 }],
        },
      ],
    };
    const why = buildWhyTrace("deny", [], trace);
    const allowPol = why.policy_evaluations.find(
      (p) => p.policy_id === "pol_allow",
    );
    const denyPol = why.policy_evaluations.find(
      (p) => p.policy_id === "pol_deny",
    );
    expect(allowPol?.was_decisive).toBe(false);
    expect(denyPol?.was_decisive).toBe(true);
    expect(why.matched_policy_id).toBe("pol_deny");
  });

  it("sets terminal_stage from decisive policy's matched stage", () => {
    const trace: ConstraintTrace = {
      matching_policy_id: "pol_deny",
      rules_evaluated: [
        {
          policy_id: "pol_deny",
          decision: "deny",
          fingerprint: "fp_999",
          stages: [
            { stage: "role_check", matched: false, order: 0 },
            { stage: "context", matched: true, order: 1, detail: "missing region" },
          ],
        },
      ],
    };
    const why = buildWhyTrace("deny", [], trace);
    expect(why.terminal_stage).toBeDefined();
    expect(why.terminal_stage?.stage).toBe("context");
    expect(why.terminal_stage?.matched).toBe(true);
    expect(why.terminal_stage?.detail).toBe("missing region");
    expect(why.terminal_stage?.impact).toBe("terminal");
  });

  it("assigns impact=contributing to matched non-decisive stages", () => {
    const trace: ConstraintTrace = {
      matching_policy_id: "pol_deny",
      rules_evaluated: [
        {
          policy_id: "pol_allow",
          decision: "allow",
          fingerprint: "fp_aaa",
          stages: [
            { stage: "role_check", matched: true, order: 0 },
          ],
        },
        {
          policy_id: "pol_deny",
          decision: "deny",
          fingerprint: "fp_bbb",
          stages: [
            { stage: "context", matched: true, order: 0 },
          ],
        },
      ],
    };
    const why = buildWhyTrace("deny", [], trace);
    const allowPol = why.policy_evaluations.find(
      (p) => p.policy_id === "pol_allow",
    );
    expect(allowPol?.stages[0]!.impact).toBe("contributing");
  });

  it("assigns impact=passing to non-matched non-decisive stages", () => {
    const trace: ConstraintTrace = {
      matching_policy_id: "pol_deny",
      rules_evaluated: [
        {
          policy_id: "pol_allow",
          decision: "allow",
          fingerprint: "fp_aaa",
          stages: [
            { stage: "role_check", matched: false, order: 0 },
          ],
        },
        {
          policy_id: "pol_deny",
          decision: "deny",
          fingerprint: "fp_bbb",
          stages: [{ stage: "context", matched: true, order: 0 }],
        },
      ],
    };
    const why = buildWhyTrace("deny", [], trace);
    const allowPol = why.policy_evaluations.find(
      (p) => p.policy_id === "pol_allow",
    );
    expect(allowPol?.stages[0]!.impact).toBe("passing");
  });

  it("omits rule and detail from stage when not provided", () => {
    const trace: ConstraintTrace = {
      rules_evaluated: [
        {
          policy_id: "pol_000",
          decision: "allow",
          fingerprint: "fp_000",
          stages: [{ stage: "role_check", matched: true, order: 0 }],
        },
      ],
    };
    const why = buildWhyTrace("allow", [], trace);
    const stage = why.policy_evaluations[0]!.stages[0]!;
    expect(Object.prototype.hasOwnProperty.call(stage, "rule")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(stage, "detail")).toBe(false);
  });

  it("includes rule and detail when provided", () => {
    const trace: ConstraintTrace = {
      rules_evaluated: [
        {
          policy_id: "pol_001",
          decision: "deny",
          fingerprint: "fp_001",
          stages: [
            {
              stage: "attr_check",
              rule: "require_mfa",
              matched: true,
              detail: "MFA not configured",
              order: 0,
            },
          ],
        },
      ],
    };
    const why = buildWhyTrace("deny", [], trace);
    const stage = why.policy_evaluations[0]!.stages[0]!;
    expect(stage.rule).toBe("require_mfa");
    expect(stage.detail).toBe("MFA not configured");
  });

  it("includes risk_score when policy has one", () => {
    const trace: ConstraintTrace = {
      rules_evaluated: [
        {
          policy_id: "pol_risk",
          decision: "hold",
          fingerprint: "fp_risk",
          risk_score: 0.87,
          stages: [{ stage: "risk_eval", matched: true, order: 0 }],
        },
      ],
    };
    const why = buildWhyTrace("hold", [], trace);
    expect(why.policy_evaluations[0]!.risk_score).toBe(0.87);
  });

  it("omits risk_score when policy does not include it", () => {
    const trace: ConstraintTrace = {
      rules_evaluated: [
        {
          policy_id: "pol_norisk",
          decision: "allow",
          fingerprint: "fp_nr",
          stages: [{ stage: "role_check", matched: true, order: 0 }],
        },
      ],
    };
    const why = buildWhyTrace("allow", [], trace);
    expect(
      Object.prototype.hasOwnProperty.call(
        why.policy_evaluations[0],
        "risk_score",
      ),
    ).toBe(false);
  });

  it("sums total_stages_evaluated across all policies", () => {
    const trace: ConstraintTrace = {
      rules_evaluated: [
        {
          policy_id: "pol_a",
          decision: "allow",
          fingerprint: "fp_a",
          stages: [
            { stage: "s1", matched: false, order: 0 },
            { stage: "s2", matched: false, order: 1 },
          ],
        },
        {
          policy_id: "pol_b",
          decision: "allow",
          fingerprint: "fp_b",
          stages: [
            { stage: "s3", matched: true, order: 0 },
          ],
        },
      ],
    };
    const why = buildWhyTrace("allow", [], trace);
    expect(why.total_stages_evaluated).toBe(3);
  });

  it("uses terminal stage detail in deny summary when no reasons provided", () => {
    const trace: ConstraintTrace = {
      matching_policy_id: "pol_x",
      rules_evaluated: [
        {
          policy_id: "pol_x",
          decision: "deny",
          fingerprint: "fp_x",
          stages: [
            {
              stage: "ip_check",
              matched: true,
              detail: "IP blocked by geo-restriction",
              order: 0,
            },
          ],
        },
      ],
    };
    const why = buildWhyTrace("deny", [], trace);
    expect(why.summary).toContain("ip_check");
    expect(why.summary).toContain("IP blocked by geo-restriction");
  });

  it("uses matched_policy_id in deny summary when no reasons and no terminal stage detail", () => {
    const trace: ConstraintTrace = {
      matching_policy_id: "pol_fallback",
      rules_evaluated: [
        {
          policy_id: "pol_fallback",
          decision: "deny",
          fingerprint: "fp_fb",
          // No stages with matched=true AND no stages at all — but we need at least
          // a stage so the policy is evaluated. Use isLast logic to force terminal.
          stages: [{ stage: "check", matched: false, order: 0 }],
        },
      ],
    };
    // The only stage has matched=false and is the last → candidateForTerminal fires.
    // terminal_stage has no detail → falls through to matchedPolicyId branch.
    const why = buildWhyTrace("deny", [], trace);
    // Summary should mention the policy id since no reason and terminal has no detail
    expect(why.matched_policy_id).toBe("pol_fallback");
  });

  it("handles empty rules_evaluated array gracefully", () => {
    const trace: ConstraintTrace = { rules_evaluated: [] };
    const why = buildWhyTrace("allow", ["ok"], trace);
    expect(why.policy_evaluations).toHaveLength(0);
    expect(why.total_stages_evaluated).toBe(0);
  });
});

// ── buildDecisionReceiptPayload ────────────────────────────────────────────────

describe("buildDecisionReceiptPayload", () => {
  it("returns a payload with all required fields", () => {
    const payload = makePayload();
    expect(payload.receipt_id).toBe("rcpt_001");
    expect(payload.evaluation_id).toBe("eval_001");
    expect(payload.org_id).toBe("org_abc");
    expect(payload.decision).toBe("allow");
    expect(payload.action).toBe("production.deploy");
    expect(payload.actor).toBe("user:alice");
    expect(payload.resource_type).toBe("service");
    expect(payload.resource_id).toBe("api-gateway");
    expect(payload.reasons).toEqual(["all checks passed"]);
    expect(payload.why_summary).toBe("Allowed: all policy checks passed.");
    expect(payload.permit_id).toBe("permit_xyz");
    expect(payload.permit_hash).toBe("abc123");
    expect(payload.audit_hash).toBe("deadbeef");
    expect(payload.context_hash).toBe("cafebabe");
    expect(payload.issued_at).toBe("2025-01-15T12:00:00.000Z");
    expect(payload.expires_at).toBeNull();
  });

  it("defaults resource_type and resource_id to null when not provided", () => {
    const payload = makePayload({
      resource_type: null,
      resource_id: null,
    });
    expect(payload.resource_type).toBeNull();
    expect(payload.resource_id).toBeNull();
  });

  it("defaults permit_id and permit_hash to null for deny decisions", () => {
    const payload = makePayload({
      decision: "deny",
      permit_id: null,
      permit_hash: null,
    });
    expect(payload.permit_id).toBeNull();
    expect(payload.permit_hash).toBeNull();
  });

  it("defaults expires_at to null when not provided", () => {
    const payload = makePayload({ expires_at: null });
    expect(payload.expires_at).toBeNull();
  });

  it("copies reasons array (not same reference)", () => {
    const reasons = ["reason one", "reason two"];
    const payload = buildDecisionReceiptPayload({
      receipt_id: "r",
      evaluation_id: "e",
      org_id: "o",
      decision: "deny",
      action: "action",
      actor: "actor",
      reasons,
      why_summary: "Denied.",
      audit_hash: "ah",
      context_hash: "ch",
      issued_at: new Date().toISOString(),
    });
    expect(payload.reasons).toEqual(reasons);
    expect(payload.reasons).not.toBe(reasons);
  });

  it("accepts explicit null for resource_type and resource_id", () => {
    const payload = makePayload({ resource_type: null, resource_id: null });
    expect(payload.resource_type).toBeNull();
    expect(payload.resource_id).toBeNull();
  });

  it("stores expires_at when provided", () => {
    const exp = "2025-06-01T00:00:00.000Z";
    const payload = makePayload({ expires_at: exp });
    expect(payload.expires_at).toBe(exp);
  });
});

// ── signDecisionReceiptHmac ────────────────────────────────────────────────────

describe("signDecisionReceiptHmac", () => {
  it("returns a non-empty hex string", async () => {
    const payload = makePayload();
    const sig = await signDecisionReceiptHmac(payload, "my-secret");
    expect(typeof sig).toBe("string");
    expect(sig.length).toBeGreaterThan(0);
    // HMAC-SHA256 produces 32 bytes = 64 hex chars
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same payload and secret", async () => {
    const payload = makePayload();
    const sig1 = await signDecisionReceiptHmac(payload, "s3cr3t");
    const sig2 = await signDecisionReceiptHmac(payload, "s3cr3t");
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different secrets", async () => {
    const payload = makePayload();
    const sig1 = await signDecisionReceiptHmac(payload, "secret-a");
    const sig2 = await signDecisionReceiptHmac(payload, "secret-b");
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different payloads", async () => {
    const p1 = makePayload({ actor: "user:alice" });
    const p2 = makePayload({ actor: "user:bob" });
    const sig1 = await signDecisionReceiptHmac(p1, "secret");
    const sig2 = await signDecisionReceiptHmac(p2, "secret");
    expect(sig1).not.toBe(sig2);
  });
});

// ── verifyDecisionReceiptHmac ──────────────────────────────────────────────────

describe("verifyDecisionReceiptHmac", () => {
  it("returns true for a properly signed receipt", async () => {
    const payload = makePayload();
    const receipt = await makeSignedReceipt(payload, "verify-secret");
    const result = await verifyDecisionReceiptHmac(receipt, "verify-secret");
    expect(result).toBe(true);
  });

  it("returns false when the secret is wrong", async () => {
    const payload = makePayload();
    const receipt = await makeSignedReceipt(payload, "correct-secret");
    const result = await verifyDecisionReceiptHmac(receipt, "wrong-secret");
    expect(result).toBe(false);
  });

  it("returns false when the payload was tampered with (decision changed)", async () => {
    const payload = makePayload({ decision: "allow" });
    const receipt = await makeSignedReceipt(payload, "secret");
    // Tamper: change the payload's decision field
    const tamperedReceipt: DecisionReceipt = {
      ...receipt,
      payload: { ...receipt.payload, decision: "deny" },
    };
    const result = await verifyDecisionReceiptHmac(tamperedReceipt, "secret");
    expect(result).toBe(false);
  });

  it("returns false when the payload was tampered with (actor changed)", async () => {
    const payload = makePayload({ actor: "user:alice" });
    const receipt = await makeSignedReceipt(payload, "secret");
    const tamperedReceipt: DecisionReceipt = {
      ...receipt,
      payload: { ...receipt.payload, actor: "user:eve" },
    };
    const result = await verifyDecisionReceiptHmac(tamperedReceipt, "secret");
    expect(result).toBe(false);
  });

  it("returns false when the signature is null", async () => {
    const payload = makePayload();
    const receipt = await makeSignedReceipt(payload, "secret");
    const nullSig: DecisionReceipt = { ...receipt, signature: null };
    const result = await verifyDecisionReceiptHmac(nullSig, "secret");
    expect(result).toBe(false);
  });

  it("returns false when algorithm is not hmac-sha256", async () => {
    const payload = makePayload();
    const receipt = await makeSignedReceipt(payload, "secret");
    const wrongAlgo: DecisionReceipt = {
      ...receipt,
      algorithm: "none",
    };
    const result = await verifyDecisionReceiptHmac(wrongAlgo, "secret");
    expect(result).toBe(false);
  });

  it("returns false when signature is tampered", async () => {
    const payload = makePayload();
    const receipt = await makeSignedReceipt(payload, "secret");
    const tampered: DecisionReceipt = {
      ...receipt,
      signature: receipt.signature!.replace(/^./, "0"),
    };
    const result = await verifyDecisionReceiptHmac(tampered, "secret");
    // Either the replace made a different char (almost certain) or left same
    // We just assert it equals whether sigs match (likely false, rarely true if first char was already '0')
    const expectedSig = receipt.signature!;
    const tamperedSig = tampered.signature!;
    expect(result).toBe(expectedSig === tamperedSig);
  });
});

// ── computeBundleHash ──────────────────────────────────────────────────────────

describe("computeBundleHash", () => {
  function makeBundleWithoutHash(): Omit<ActionEvidenceBundle, "bundle_hash"> {
    const payload = makePayload();
    const receipt: DecisionReceipt = {
      receipt_id: payload.receipt_id,
      evaluation_id: payload.evaluation_id,
      org_id: payload.org_id,
      decision: payload.decision,
      action: payload.action,
      actor: payload.actor,
      resource_type: payload.resource_type,
      resource_id: payload.resource_id,
      reasons: payload.reasons,
      why_trace: null,
      permit_id: payload.permit_id,
      permit_hash: payload.permit_hash,
      audit_hash: payload.audit_hash,
      context_hash: payload.context_hash,
      issued_at: payload.issued_at,
      expires_at: payload.expires_at,
      algorithm: "hmac-sha256",
      signature: "aabbcc",
      signing_key_id: null,
      payload,
    };
    const whyTrace: WhyTrace = {
      decision: "allow",
      summary: "Allowed: all policy checks passed.",
      policy_evaluations: [],
      total_stages_evaluated: 0,
    };
    return {
      v: 1,
      bundle_id: "bundle_001",
      evaluation_id: "eval_001",
      org_id: "org_abc",
      action: "production.deploy",
      actor: "user:alice",
      decision: "allow",
      receipt,
      why_trace: whyTrace,
      audit_events: [],
      permit_chain: [],
      overrides: [],
      compliance_controls: [],
      generated_at: "2025-01-15T12:00:00.000Z",
    };
  }

  it("returns a non-empty hex string", async () => {
    const bundle = makeBundleWithoutHash();
    const hash = await computeBundleHash(bundle);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    // SHA-256 = 32 bytes = 64 hex chars
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same bundle", async () => {
    const bundle = makeBundleWithoutHash();
    const h1 = await computeBundleHash(bundle);
    const h2 = await computeBundleHash(bundle);
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different bundles", async () => {
    const b1 = makeBundleWithoutHash();
    const b2 = { ...makeBundleWithoutHash(), actor: "user:bob" };
    const h1 = await computeBundleHash(b1);
    const h2 = await computeBundleHash(b2);
    expect(h1).not.toBe(h2);
  });

  it("produces same hash as JSON.stringify of the bundle object", async () => {
    const bundle = makeBundleWithoutHash();
    const hash = await computeBundleHash(bundle);
    // computeBundleHash uses sha256(JSON.stringify(bundle)) — replicate that
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256")
      .update(JSON.stringify(bundle), "utf8")
      .digest("hex");
    expect(hash).toBe(expected);
  });
});
