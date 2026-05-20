/**
 * Evidence Engine — per-decision proof artifacts, "why" traces, and
 * compliance-ready bundles.
 *
 * Turn every AtlaSent decision into tamper-evident proof that buyers
 * can hand to auditors, compliance teams, and regulators.
 *
 * Primary entry points:
 *
 * 1. `buildWhyTrace(decision, reasons, constraintTrace)` — converts
 *    the ConstraintTrace from `?include=constraint_trace` into a
 *    structured human/machine-readable "why allowed / why denied" trace.
 *
 * 2. `buildDecisionReceiptPayload(args)` — assembles the canonical
 *    signable payload for a per-decision receipt.
 *
 * 3. `signDecisionReceiptHmac(payload, secret)` — HMAC-SHA256 sign.
 *
 * 4. `verifyDecisionReceiptHmac(receipt, secret)` — offline verify.
 *
 * 5. `computeBundleHash(bundle)` — SHA-256 of an ActionEvidenceBundle.
 *
 * 6. `soc2ControlCoverageForDecision(opts)` — map a decision to SOC 2
 *    control coverage.
 *
 * The {@link DecisionReceipt} is the category-defining artifact: a
 * self-contained, signed, human-readable proof that a specific action
 * was (or was not) authorized at a specific moment. Every enforcement
 * adapter produces one; every compliance bundle includes one.
 */

import type {
  ConstraintTrace,
  ConstraintTracePolicy,
  ConstraintTraceStage,
  DecisionCanonical,
  PermitRecord,
} from "./types.js";
import type { AuditEvent } from "./audit.js";
import type { OverrideV1 } from "./overrides.js";
import type { ComplianceFramework } from "./complianceEvidence.js";

// ── Why Trace ─────────────────────────────────────────────────────────────────

/**
 * One evaluated stage within a policy, in the order the engine ran it.
 */
export interface WhyStage {
  /** Engine stage name (e.g. `"role_check"`, `"context"`). */
  stage: string;
  /** Rule identifier, if the stage is rule-bound. */
  rule?: string;
  /** Whether this stage's predicate fired / matched. */
  matched: boolean;
  /** Non-obvious detail from the engine. */
  detail?: string;
  /**
   * Impact classification:
   * - `"terminal"` — this stage caused the outer decision.
   * - `"contributing"` — matched but was not the decisive stage.
   * - `"passing"` — did not match; execution continued.
   */
  impact: "terminal" | "contributing" | "passing";
}

/** Per-policy evaluation block within a WhyTrace. */
export interface WhyPolicyEvaluation {
  policy_id: string;
  /** Policy-level decision. */
  decision: string;
  /** Engine-side fingerprint of the policy bundle row. */
  fingerprint: string;
  /** Optional risk score from a `risk` rule clause. */
  risk_score?: number;
  /** Stages evaluated for this policy, in order. */
  stages: WhyStage[];
  /** `true` iff this policy's decision drove the outer envelope decision. */
  was_decisive: boolean;
}

/**
 * Structured "why allowed / why denied" trace.
 *
 * Produced by `buildWhyTrace()` from the `ConstraintTrace` returned
 * by `/v1-evaluate?include=constraint_trace`. Suitable for:
 *
 * - UI display ("Why was this denied?")
 * - Email / Slack notifications
 * - Compliance-bundle human-readable section
 * - Machine-readable policy audit by external verifiers
 *
 * `summary` is a one-sentence plain-English explanation.
 */
export interface WhyTrace {
  decision: DecisionCanonical;
  /** One-sentence human-readable explanation. */
  summary: string;
  /** Policy whose decision drove the outer result. Absent on clean allow. */
  matched_policy_id?: string;
  /** Per-policy evaluation blocks in evaluation order. */
  policy_evaluations: WhyPolicyEvaluation[];
  /**
   * The single stage that caused the terminal outcome, extracted for
   * quick access. `undefined` on a clean allow (no blocking stage).
   */
  terminal_stage?: WhyStage;
  /** Total stages evaluated across all policies. */
  total_stages_evaluated: number;
}

// ── Decision Receipt ──────────────────────────────────────────────────────────

/** Signing algorithm tag on a {@link DecisionReceipt}. */
export type DecisionReceiptAlgorithm = "hmac-sha256" | "ed25519" | "none";

/**
 * The canonical signed payload of a {@link DecisionReceipt}.
 *
 * Field order is load-bearing: HMAC and chain verifiers stringify
 * this object and must reproduce byte-identical output. Never reorder
 * the fields; add new optional fields at the end only.
 */
export interface DecisionReceiptPayload {
  receipt_id: string;
  evaluation_id: string;
  org_id: string;
  decision: DecisionCanonical;
  action: string;
  actor: string;
  resource_type: string | null;
  resource_id: string | null;
  reasons: string[];
  /** One-sentence human-readable summary from the WhyTrace. */
  why_summary: string;
  /** Permit ID when the decision was `"allow"`. */
  permit_id: string | null;
  /** Permit verification hash when the decision was `"allow"`. */
  permit_hash: string | null;
  /** Hash-chained audit-trail entry from the evaluate response. */
  audit_hash: string;
  /** SHA-256 hex of canonical JSON of the evaluate context. */
  context_hash: string;
  /** ISO-8601 when this receipt was issued. */
  issued_at: string;
  /** ISO-8601 TTL, or `null` for non-expiring receipts. */
  expires_at: string | null;
}

/**
 * A signed, tamper-evident record of a single AtlaSent authorization
 * decision. Self-contained: contains everything an auditor needs to
 * verify the decision without querying the API.
 *
 * **Signature semantics (HMAC-SHA256):**
 *
 *   `HMAC-SHA256(secret,
 *     receipt_id + "\\n" + issued_at + "\\n" + JSON.stringify(payload))`
 *
 * When `algorithm === "ed25519"`, `signature` is hex-encoded Ed25519
 * over the same input string encoded as UTF-8.
 *
 * Offline verification: `verifyDecisionReceiptHmac(receipt, secret)`.
 *
 * Callers MUST reject receipts where `algorithm === "none"` in any
 * context requiring tamper-evidence.
 */
export interface DecisionReceipt {
  receipt_id: string;
  evaluation_id: string;
  org_id: string;
  decision: DecisionCanonical;
  action: string;
  actor: string;
  resource_type: string | null;
  resource_id: string | null;
  reasons: string[];
  /**
   * Full structured "why" trace. `null` when the evaluation was
   * performed without `?include=constraint_trace`.
   */
  why_trace: WhyTrace | null;
  permit_id: string | null;
  permit_hash: string | null;
  audit_hash: string;
  /** SHA-256 hex of canonical JSON of the evaluate context. */
  context_hash: string;
  issued_at: string;
  expires_at: string | null;
  algorithm: DecisionReceiptAlgorithm;
  /**
   * Hex (HMAC-SHA256 or Ed25519) signature, or `null` when
   * `algorithm === "none"`.
   */
  signature: string | null;
  /** Registry key ID that signed, when `algorithm !== "none"`. */
  signing_key_id: string | null;
  /**
   * Full payload that was signed. Pass to `verifyDecisionReceiptHmac`
   * or reconstruct independently for external verification.
   */
  payload: DecisionReceiptPayload;
}

// ── Action Evidence Bundle ────────────────────────────────────────────────────

/** Coverage summary for one compliance control within a bundle. */
export interface ComplianceControlCoverage {
  framework: ComplianceFramework;
  control_id: string;
  title: string;
  /** `true` when this bundle provides sufficient evidence for the control. */
  covered: boolean;
  /** Evidence kinds present in the bundle that map to this control. */
  evidence_kinds: string[];
}

/**
 * A compliance-ready evidence bundle for a single protected action.
 *
 * Contains everything an auditor needs to verify the authorization
 * decision without querying the API:
 *
 * - The signed {@link DecisionReceipt}
 * - The "why" trace (why allowed / why denied)
 * - Audit events from the decision window
 * - Permit chain (when the decision was `"allow"`)
 * - Active overrides that influenced the decision
 * - Per-control SOC 2 / compliance coverage map
 *
 * `bundle_hash` is SHA-256 of `JSON.stringify(bundle)` with
 * `bundle_hash` omitted, computed by `computeBundleHash()`. Use it
 * to verify the bundle was not modified after assembly.
 */
export interface ActionEvidenceBundle {
  /** Wire format version. */
  v: 1;
  bundle_id: string;
  evaluation_id: string;
  org_id: string;
  action: string;
  actor: string;
  decision: DecisionCanonical;
  receipt: DecisionReceipt;
  why_trace: WhyTrace | null;
  /** Audit events from the evaluation window related to this action. */
  audit_events: AuditEvent[];
  /** Permit chain when the decision was `"allow"`. */
  permit_chain: PermitRecord[];
  /** Active overrides that influenced the decision. */
  overrides: OverrideV1[];
  compliance_controls: ComplianceControlCoverage[];
  generated_at: string;
  /** SHA-256 hex of canonical JSON of this bundle (sans this field). */
  bundle_hash: string;
}

// ── buildWhyTrace ─────────────────────────────────────────────────────────────

/**
 * Convert a raw `ConstraintTrace` (from `?include=constraint_trace`)
 * into a structured {@link WhyTrace} with a human-readable summary.
 *
 * Safe to call with `trace === null` — returns a minimal trace with
 * the decision and a generic summary derived from `reasons`.
 *
 * ```ts
 * import { buildWhyTrace } from "@atlasent/sdk";
 *
 * const preflight = await client.evaluatePreflight({ agent, action, context });
 * const why = buildWhyTrace(
 *   preflight.evaluation.decision_canonical,
 *   preflight.evaluation.reasons,
 *   preflight.constraintTrace,
 * );
 * console.log(why.summary);
 * // "Denied at stage 'role_check': actor lacks deploy role"
 * ```
 */
export function buildWhyTrace(
  decision: DecisionCanonical,
  reasons: readonly string[],
  trace: ConstraintTrace | null,
): WhyTrace {
  if (!trace) {
    return {
      decision,
      summary: formatSummary(decision, reasons, undefined, undefined),
      policy_evaluations: [],
      total_stages_evaluated: 0,
    };
  }

  const matchedPolicyId: string | undefined =
    typeof trace.matching_policy_id === "string"
      ? trace.matching_policy_id
      : undefined;

  let terminalStage: WhyStage | undefined;
  let totalStages = 0;

  const policyEvaluations: WhyPolicyEvaluation[] = (
    trace.rules_evaluated ?? []
  ).map((policy: ConstraintTracePolicy) => {
    const wasDecisive = matchedPolicyId === policy.policy_id;
    let foundTerminal = false;

    const stages: WhyStage[] = (policy.stages ?? []).map(
      (s: ConstraintTraceStage, idx: number) => {
        totalStages++;
        const isLast = idx === (policy.stages?.length ?? 1) - 1;
        const candidateForTerminal =
          wasDecisive && !foundTerminal && (s.matched || isLast);

        let impact: WhyStage["impact"] = "passing";

        if (candidateForTerminal) {
          impact = "terminal";
          foundTerminal = true;
          terminalStage = {
            stage: s.stage,
            rule: s.rule,
            matched: s.matched,
            detail: s.detail,
            impact: "terminal",
          };
        } else if (s.matched) {
          impact = "contributing";
        }

        return {
          stage: s.stage,
          rule: s.rule,
          matched: s.matched,
          detail: s.detail,
          impact,
        };
      },
    );

    return {
      policy_id: policy.policy_id,
      decision: policy.decision,
      fingerprint: policy.fingerprint,
      risk_score: policy.risk_score,
      stages,
      was_decisive: wasDecisive,
    };
  });

  return {
    decision,
    summary: formatSummary(decision, reasons, matchedPolicyId, terminalStage),
    matched_policy_id: matchedPolicyId,
    policy_evaluations: policyEvaluations,
    terminal_stage: terminalStage,
    total_stages_evaluated: totalStages,
  };
}

function formatSummary(
  decision: DecisionCanonical,
  reasons: readonly string[],
  matchedPolicyId: string | undefined,
  terminalStage: WhyStage | undefined,
): string {
  const reason0 = reasons.length > 0 ? reasons[0] : undefined;
  switch (decision) {
    case "allow":
      return reason0
        ? `Allowed: ${reason0}`
        : "Allowed: all policy checks passed.";
    case "deny":
      if (reason0) return `Denied: ${reason0}`;
      if (terminalStage?.detail)
        return `Denied at stage "${terminalStage.stage}": ${terminalStage.detail}`;
      if (terminalStage)
        return `Denied at stage "${terminalStage.stage}".`;
      if (matchedPolicyId)
        return `Denied by policy ${matchedPolicyId}.`;
      return "Denied: policy check failed.";
    case "hold":
      return reason0
        ? `Held for review: ${reason0}`
        : "Held pending human review.";
    case "escalate":
      return reason0
        ? `Escalated: ${reason0}`
        : "Escalated to a human reviewer.";
  }
}

// ── Crypto helpers ────────────────────────────────────────────────────────────

function sortedJSON(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "number")
    return Number.isFinite(val) ? String(val) : "null";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "string") return JSON.stringify(val);
  if (Array.isArray(val)) return "[" + val.map(sortedJSON).join(",") + "]";
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    return (
      "{" +
      Object.keys(obj)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + sortedJSON(obj[k]))
        .join(",") +
      "}"
    );
  }
  return "null";
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  if (
    typeof globalThis !== "undefined" &&
    globalThis.crypto?.subtle?.digest
  ) {
    const buf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return hexEncode(new Uint8Array(buf));
  }
  try {
    const { createHash } = await import(
      /* @vite-ignore */ /* webpackIgnore: true */ "node:crypto"
    );
    return createHash("sha256").update(input, "utf8").digest("hex");
  } catch {
    return "";
  }
}

// ── Context hash ──────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hex of the recursively key-sorted canonical JSON of
 * `context`. Used as `context_hash` on a `DecisionReceipt` so the
 * original evaluate context can be independently verified offline.
 */
export async function computeContextHash(
  context: Record<string, unknown>,
): Promise<string> {
  return sha256Hex(sortedJSON(context));
}

// ── Receipt payload builder ───────────────────────────────────────────────────

/**
 * Assemble a {@link DecisionReceiptPayload} — the canonical object
 * that is serialised and signed. Field insertion order is fixed;
 * do NOT reorder the fields below.
 */
export function buildDecisionReceiptPayload(args: {
  receipt_id: string;
  evaluation_id: string;
  org_id: string;
  decision: DecisionCanonical;
  action: string;
  actor: string;
  resource_type?: string | null;
  resource_id?: string | null;
  reasons: readonly string[];
  why_summary: string;
  permit_id?: string | null;
  permit_hash?: string | null;
  audit_hash: string;
  context_hash: string;
  issued_at: string;
  expires_at?: string | null;
}): DecisionReceiptPayload {
  return {
    receipt_id: args.receipt_id,
    evaluation_id: args.evaluation_id,
    org_id: args.org_id,
    decision: args.decision,
    action: args.action,
    actor: args.actor,
    resource_type: args.resource_type ?? null,
    resource_id: args.resource_id ?? null,
    reasons: Array.from(args.reasons),
    why_summary: args.why_summary,
    permit_id: args.permit_id ?? null,
    permit_hash: args.permit_hash ?? null,
    audit_hash: args.audit_hash,
    context_hash: args.context_hash,
    issued_at: args.issued_at,
    expires_at: args.expires_at ?? null,
  };
}

/**
 * Canonical input string signed by both HMAC-SHA256 and Ed25519
 * receipt signers.
 *
 * Format: `receipt_id + "\n" + issued_at + "\n" + JSON.stringify(payload)`
 */
export function receiptSigningInput(payload: DecisionReceiptPayload): string {
  return (
    payload.receipt_id +
    "\n" +
    payload.issued_at +
    "\n" +
    JSON.stringify(payload)
  );
}

// ── HMAC-SHA256 sign / verify ─────────────────────────────────────────────────

/**
 * HMAC-SHA256 sign a {@link DecisionReceiptPayload}. Returns the
 * hex-encoded MAC. Store as `receipt.signature` with
 * `algorithm: "hmac-sha256"`.
 *
 * Uses `crypto.subtle` (browser / Node 20+ / Cloudflare) or falls
 * back to `node:crypto` on older Node runtimes.
 */
export async function signDecisionReceiptHmac(
  payload: DecisionReceiptPayload,
  secret: string,
): Promise<string> {
  const input = receiptSigningInput(payload);
  const keyBytes = new TextEncoder().encode(secret);
  const msgBytes = new TextEncoder().encode(input);

  if (typeof globalThis !== "undefined" && globalThis.crypto?.subtle) {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await globalThis.crypto.subtle.sign("HMAC", key, msgBytes);
    return hexEncode(new Uint8Array(sig));
  }

  try {
    const { createHmac } = await import(
      /* @vite-ignore */ /* webpackIgnore: true */ "node:crypto"
    );
    return createHmac("sha256", secret).update(input).digest("hex");
  } catch {
    return "";
  }
}

/**
 * Verify an HMAC-SHA256-signed {@link DecisionReceipt} offline.
 * Returns `false` (does not throw) on any verification failure.
 *
 * Callers MUST reject receipts where `receipt.algorithm !== "hmac-sha256"`.
 */
export async function verifyDecisionReceiptHmac(
  receipt: DecisionReceipt,
  secret: string,
): Promise<boolean> {
  if (receipt.algorithm !== "hmac-sha256" || !receipt.signature) return false;
  const expected = await signDecisionReceiptHmac(receipt.payload, secret);
  return timingSafeEqual(expected, receipt.signature);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ── Bundle hash ───────────────────────────────────────────────────────────────

/**
 * Compute SHA-256 hex of `JSON.stringify(bundle)` with `bundle_hash`
 * omitted. Store as `bundle.bundle_hash` after assembly.
 *
 * An external verifier can reproduce this value independently to
 * confirm the bundle was not modified after export.
 */
export async function computeBundleHash(
  bundle: Omit<ActionEvidenceBundle, "bundle_hash">,
): Promise<string> {
  return sha256Hex(JSON.stringify(bundle));
}

// ── Compliance control coverage ───────────────────────────────────────────────

/**
 * Return the SOC 2 controls covered by a single authorization decision,
 * given what the bundle contains. Suitable for populating
 * `ActionEvidenceBundle.compliance_controls`.
 *
 * For ISO 27001 / GDPR / HIPAA coverage use the `@atlasent/evidence-bundle`
 * package's `buildEvidenceBundle()` which handles multi-framework mapping.
 */
export function soc2ControlCoverageForDecision(opts: {
  decision: DecisionCanonical;
  hasPermitChain: boolean;
  hasAuditEvents: boolean;
  hasOverrides: boolean;
}): ComplianceControlCoverage[] {
  return [
    {
      framework: "soc2",
      control_id: "CC7.2",
      title: "Audit trail completeness",
      covered: opts.hasAuditEvents,
      evidence_kinds: ["audit_log_slice"],
    },
    {
      framework: "soc2",
      control_id: "CC8.1",
      title: "Change management / HITL authorization",
      covered: opts.decision === "allow" && opts.hasPermitChain,
      evidence_kinds: ["permit_chain"],
    },
    {
      framework: "soc2",
      control_id: "CC6.1",
      title: "Logical access controls — authorization enforcement",
      covered: true,
      evidence_kinds: ["policy_snapshot"],
    },
    {
      framework: "soc2",
      control_id: "CC3.2",
      title: "Policy violations and override tracking",
      covered: opts.hasOverrides,
      evidence_kinds: ["policy_snapshot", "permit_chain"],
    },
  ];
}
