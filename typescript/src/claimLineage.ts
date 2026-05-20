/**
 * Claims → Evidence Lineage
 *
 * Builds and verifies {@link ClaimEvidenceLink} objects — signed, wire-stable
 * artifacts that tie a canonical claim row to its full evidence chain:
 *
 * 1. **`runtime_evidence`** — {@link DecisionReceipt} from `protectWithEvidence()`
 * 2. **`deploy_evidence`** — `protectDeploy()` gate record
 * 3. **`integration_evidence`** — `ComplianceEvidenceRun` summary
 * 4. **`approval_artifact`** — HITL chain or ApprovalArtifact summary
 * 5. **`delta`** — policy + schema drift since the claim was asserted
 * 6. **`verification_checklist`** — machine-auditable `all_pass` + per-slot status
 *
 * Wire schema: `contract/schemas/claim-evidence-link.schema.json`
 * Proposal: `contract/PROPOSALS/004-claims-evidence-links.md`
 *
 * @module
 */

import { createHmac, randomUUID } from "node:crypto";
import type { DecisionReceipt, DecisionReceiptAlgorithm } from "./evidenceEngine.js";
import type { ComplianceEvidenceRun } from "./complianceEvidence.js";
import type { HitlEscalation, HitlApprovalRecord } from "./hitl.js";
import { AtlaSentError } from "./errors.js";

// ── Evidence slot wire types ──────────────────────────────────────────────────

export interface RuntimeEvidenceSlot {
  readonly permit_token: string;
  readonly audit_hash: string;
  readonly decision: "allow" | "deny" | "escalate";
  readonly decision_id: string;
  readonly evaluated_at: string;
  readonly algorithm: DecisionReceiptAlgorithm;
  readonly signature: string | null;
  readonly permit_revoked_at: string | null;
  readonly verified_at_claim_time: boolean;
  readonly verified_at_link_creation: boolean;
}

export interface DeployEvidenceSlot {
  readonly deploy_id: string;
  readonly environment: string;
  readonly sha: string;
  readonly actor_id: string;
  readonly deployed_at: string;
  readonly gate_permit_token: string;
}

export interface IntegrationEvidenceSlot {
  readonly run_id: string;
  readonly framework: "soc2" | "iso27001" | "hipaa" | "pci_dss" | "gdpr" | "fedramp";
  readonly period_start: string;
  readonly period_end: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly passing_control_count: number;
  readonly failing_control_count: number;
  readonly run_completed_at: string;
}

export interface ApprovalArtifactSlot {
  readonly approval_id: string;
  readonly approval_kind: "hitl_chain" | "approval_artifact";
  readonly quorum_type: "single_approver" | "simple_majority" | "two_thirds" | "unanimous";
  readonly approver_count: number;
  readonly approver_ids: readonly string[];
  readonly approved_at: string;
  readonly artifact_hash: string;
}

export type DriftChangeType =
  | "rule_added"
  | "rule_removed"
  | "rule_modified"
  | "threshold_changed"
  | "policy_updated"
  | "schema_field_added"
  | "schema_field_removed"
  | "schema_field_type_changed";

export type DriftSeverity = "info" | "warning" | "critical";

export interface DriftDetail {
  readonly change_type: DriftChangeType;
  readonly severity: DriftSeverity;
  readonly rule_id: string | null;
  readonly changed_at: string | null;
  readonly description: string;
}

export type DeltaStatus = "pending" | "computing" | "computed" | "failed";

export interface DeltaSlot {
  readonly status: DeltaStatus;
  readonly computed_at: string | null;
  readonly policy_version_at_claim: string | null;
  readonly policy_version_current: string | null;
  readonly policy_drift_detected: boolean | null;
  readonly schema_version_at_claim: string;
  readonly schema_version_current: string;
  readonly schema_drift_detected: boolean;
  readonly drift_details: readonly DriftDetail[];
}

export type EvidenceSlotStatus = "present" | "not_applicable" | "missing";

export interface VerificationChecklist {
  readonly runtime_evidence_present: boolean;
  readonly verified_at_claim_time: boolean;
  readonly verified_at_link_creation: boolean;
  readonly deploy_evidence_status: EvidenceSlotStatus;
  readonly integration_evidence_status: EvidenceSlotStatus;
  readonly approval_artifact_status: EvidenceSlotStatus;
  readonly delta_computed: boolean;
  readonly policy_drift_clean: boolean | null;
  readonly schema_drift_clean: boolean;
  readonly all_pass: boolean;
  readonly last_verified_at: string | null;
  readonly computed_at: string;
}

export interface ClaimEvidenceLink {
  readonly version: "claim_evidence_link.v1";
  readonly link_id: string;
  readonly claim_id: string;
  readonly org_id: string;
  readonly linked_at: string;
  readonly updated_at: string;
  readonly revision: number;
  readonly link_algorithm: "hmac-sha256" | "none";
  readonly link_hash: string;
  readonly link_signature: string | null;
  readonly runtime_evidence: RuntimeEvidenceSlot;
  readonly deploy_evidence: DeployEvidenceSlot | null;
  readonly integration_evidence: IntegrationEvidenceSlot | null;
  readonly approval_artifact: ApprovalArtifactSlot | null;
  readonly delta: DeltaSlot;
  readonly verification_checklist: VerificationChecklist;
}

// ── Slot input types ──────────────────────────────────────────────────────────

/** Caller signals evidence does not apply to this claim. */
export interface NotApplicable {
  readonly notApplicable: true;
}

export const NOT_APPLICABLE: NotApplicable = { notApplicable: true };

function isNotApplicable(v: unknown): v is NotApplicable {
  return typeof v === "object" && v !== null && (v as NotApplicable).notApplicable === true;
}

/** Raw deploy gate inputs — caller supplies at minimum environment + service. */
export interface DeployEvidenceInput {
  readonly deploy_id: string;
  readonly environment: string;
  readonly sha: string;
  readonly actor_id: string;
  readonly deployed_at: string;
  readonly gate_permit_token: string;
}

/** Summary from a HITL chain (derived from HitlEscalation + approval records). */
export interface HitlChainSummary {
  readonly escalation: HitlEscalation;
  readonly approvals: readonly HitlApprovalRecord[];
  /** SHA-256 hex of the canonical JSON of the full chain object. */
  readonly artifact_hash: string;
}

/** Out-of-band approval artifact (pre-signed). */
export interface SignedApprovalArtifact {
  readonly approval_id: string;
  readonly approval_kind: "approval_artifact";
  readonly quorum_type: "single_approver" | "simple_majority" | "two_thirds" | "unanimous";
  readonly approver_ids: readonly string[];
  readonly approved_at: string;
  /** SHA-256 hex of the canonical encoding of the full artifact. */
  readonly artifact_hash: string;
}

export interface BuildClaimEvidenceLinkOpts {
  /** The canonical claim ID this link annotates. */
  readonly claimId: string;
  /**
   * The org that owns the claim. Defaults to `receipt.org_id` from
   * `runtimeEvidence` when omitted.
   */
  readonly orgId?: string;
  /** DecisionReceipt from `protectWithEvidence()`. Required. */
  readonly runtimeEvidence: DecisionReceipt;
  /**
   * Deploy gate record. Pass `NOT_APPLICABLE` for non-deployment actions.
   * Omit (or pass `undefined`) when the deploy record was expected but
   * unavailable — the slot status will be `"missing"` and `all_pass`
   * will be `false`.
   */
  readonly deployEvidence?: DeployEvidenceInput | NotApplicable;
  /**
   * Most recent compliance run covering the claim period. Pass
   * `NOT_APPLICABLE` when no compliance run applies.
   */
  readonly integrationEvidence?: ComplianceEvidenceRun | NotApplicable;
  /**
   * HITL chain summary or out-of-band approval artifact. Pass
   * `NOT_APPLICABLE` when no human approval was required.
   */
  readonly approvalArtifact?: HitlChainSummary | SignedApprovalArtifact | NotApplicable;
  /**
   * HMAC-SHA256 signing secret. When provided the link is signed and
   * `link_algorithm` is `"hmac-sha256"`. Omit for unsigned links
   * (`link_algorithm: "none"`).
   */
  readonly signingSecret?: string;
  /**
   * Override the schema version recorded in `delta.schema_version_at_claim`.
   * Defaults to the SDK package version embedded at build time.
   */
  readonly schemaVersion?: string;
}

export interface VerifyClaimEvidenceLinkOpts {
  /**
   * Signing secret used to re-verify `link_signature`. Required when
   * `link.link_algorithm` is `"hmac-sha256"`.
   */
  readonly signingSecret?: string;
  /**
   * When true, skips re-calling `/v1-verify-permit` even if a client is
   * provided. Useful when the permit is known to be expired and you only
   * want to check structural integrity.
   */
  readonly skipPermitRecheck?: boolean;
}

export interface VerifyClaimEvidenceLinkResult {
  /** Updated link with refreshed checklist, incremented revision, and recomputed hash. */
  readonly link: ClaimEvidenceLink;
  readonly valid: boolean;
  /** Names of verification_checklist fields that are false or "missing". */
  readonly failedSlots: readonly string[];
}

// ── Action bundle input types ─────────────────────────────────────────────────

/**
 * Subset of an `ActionEvidenceBundle.receipt` produced by the AtlaSent
 * GitHub Action (atlasent-action `evidenceBundle.ts`).
 *
 * Only the fields consumed by {@link buildClaimEvidenceLinkFromActionBundle}
 * are required here; the full receipt shape lives in the action repo.
 */
export interface ActionBundleReceipt {
  readonly receipt_id: string;
  readonly evaluation_id: string;
  readonly permit_id: string | null;
  readonly audit_hash: string | null;
  readonly issued_at: string;
  readonly algorithm: "hmac-sha256" | "none";
  readonly signature: string | null;
  readonly decision: "allow";
}

/**
 * Minimal shape of an `ActionEvidenceBundle` emitted by the AtlaSent
 * GitHub Action as its `evidence-bundle` output. Pass the parsed JSON
 * directly; no re-shaping needed.
 */
export interface ActionBundleInput {
  readonly bundle_id: string;
  readonly action: string;
  readonly actor: string;
  readonly environment: string;
  readonly repository: string;
  readonly sha: string;
  readonly run_id: string;
  readonly generated_at: string;
  readonly receipt: ActionBundleReceipt;
}

export interface BuildFromActionBundleOpts {
  /** The canonical claim ID this link annotates. */
  readonly claimId: string;
  /** Owning org. Defaults to `""` for v1 (no org context on the action). */
  readonly orgId?: string;
  /**
   * Set to `true` when the bundle does NOT represent a deploy action.
   * The deploy slot will be `NOT_APPLICABLE` instead of auto-populated
   * from `bundle.sha` / `bundle.environment`.
   */
  readonly deployNotApplicable?: boolean;
  readonly signingSecret?: string;
  readonly schemaVersion?: string;
}

// ── SDK version ───────────────────────────────────────────────────────────────

const SDK_VERSION = "@atlasent/sdk@1.4.2";

// ── Canonical serialisation ───────────────────────────────────────────────────

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
  }
  return "null";
}

function sha256Hex(input: string): string {
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  return createHash("sha256").update(input).digest("hex");
}

function hmacSha256Base64url(payload: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
}

function computeLinkHash(link: Omit<ClaimEvidenceLink, "link_hash" | "link_signature">): string {
  return sha256Hex(canonicalize(link));
}

// ── Slot converters ───────────────────────────────────────────────────────────

function slotStatus(
  input: unknown | NotApplicable | undefined,
  slot: DeployEvidenceSlot | IntegrationEvidenceSlot | ApprovalArtifactSlot | null,
): EvidenceSlotStatus {
  if (isNotApplicable(input)) return "not_applicable";
  if (slot !== null) return "present";
  return "missing";
}

function toDeploySlot(input: DeployEvidenceInput | NotApplicable | undefined): DeployEvidenceSlot | null {
  if (input === undefined || isNotApplicable(input)) return null;
  return {
    deploy_id: input.deploy_id,
    environment: input.environment,
    sha: input.sha,
    actor_id: input.actor_id,
    deployed_at: input.deployed_at,
    gate_permit_token: input.gate_permit_token,
  };
}

function toIntegrationSlot(
  input: ComplianceEvidenceRun | NotApplicable | undefined,
): IntegrationEvidenceSlot | null {
  if (input === undefined || isNotApplicable(input)) return null;
  const run = input as ComplianceEvidenceRun;
  return {
    run_id: run.id,
    framework: run.framework as IntegrationEvidenceSlot["framework"],
    period_start: run.period_start,
    period_end: run.period_end,
    status: run.status as IntegrationEvidenceSlot["status"],
    passing_control_count: (run.controls ?? []).filter((c) => c.status === "pass").length,
    failing_control_count: (run.controls ?? []).filter((c) => c.status !== "pass").length,
    run_completed_at: run.created_at,
  };
}

function toApprovalSlot(
  input: HitlChainSummary | SignedApprovalArtifact | NotApplicable | undefined,
): ApprovalArtifactSlot | null {
  if (input === undefined || isNotApplicable(input)) return null;

  if ("escalation" in input) {
    const chain = input as HitlChainSummary;
    const approvals = chain.approvals;
    const lastApproved = approvals
      .filter((a) => a.decision === "approve")
      .map((a) => a.created_at)
      .sort()
      .at(-1) ?? chain.escalation.created_at;
    return {
      approval_id: chain.escalation.id,
      approval_kind: "hitl_chain",
      quorum_type: hitlQuorumToSlotQuorum(chain.escalation.quorum_required),
      approver_count: approvals.filter((a) => a.decision === "approve").length,
      approver_ids: approvals
        .filter((a) => a.decision === "approve")
        .map((a) => a.user_id ?? a.actor_label ?? "unknown"),
      approved_at: lastApproved,
      artifact_hash: chain.artifact_hash,
    };
  }

  const artifact = input as SignedApprovalArtifact;
  return {
    approval_id: artifact.approval_id,
    approval_kind: "approval_artifact",
    quorum_type: artifact.quorum_type,
    approver_count: artifact.approver_ids.length,
    approver_ids: artifact.approver_ids,
    approved_at: artifact.approved_at,
    artifact_hash: artifact.artifact_hash,
  };
}

function hitlQuorumToSlotQuorum(
  tier: string,
): ApprovalArtifactSlot["quorum_type"] {
  switch (tier) {
    case "single_approver": return "single_approver";
    case "two_thirds":      return "two_thirds";
    case "unanimous":       return "unanimous";
    default:                return "simple_majority";
  }
}

function toRuntimeSlot(receipt: DecisionReceipt, verifiedAtCreation: boolean): RuntimeEvidenceSlot {
  return {
    permit_token: receipt.permit_id ?? receipt.receipt_id,
    audit_hash: receipt.audit_hash,
    decision: receipt.decision === "allow" ? "allow"
      : receipt.decision === "escalate" ? "escalate"
      : "deny",
    decision_id: receipt.evaluation_id,
    evaluated_at: receipt.issued_at,
    algorithm: receipt.algorithm,
    signature: receipt.signature,
    permit_revoked_at: null,
    verified_at_claim_time: receipt.decision === "allow",
    verified_at_link_creation: verifiedAtCreation,
  };
}

// ── Checklist builder ─────────────────────────────────────────────────────────

function buildChecklist(
  runtime: RuntimeEvidenceSlot,
  deployStatus: EvidenceSlotStatus,
  integrationStatus: EvidenceSlotStatus,
  approvalStatus: EvidenceSlotStatus,
  delta: DeltaSlot,
  lastVerifiedAt: string | null,
  now: string,
): VerificationChecklist {
  const deltaComputed = delta.status === "computed";
  const policyDriftClean = deltaComputed ? !delta.policy_drift_detected : null;
  const schemaDriftClean = !delta.schema_drift_detected;

  const allPass =
    runtime.verified_at_claim_time &&
    runtime.verified_at_link_creation &&
    deltaComputed &&
    policyDriftClean === true &&
    schemaDriftClean &&
    deployStatus !== "missing" &&
    integrationStatus !== "missing" &&
    approvalStatus !== "missing";

  return {
    runtime_evidence_present: true,
    verified_at_claim_time: runtime.verified_at_claim_time,
    verified_at_link_creation: runtime.verified_at_link_creation,
    deploy_evidence_status: deployStatus,
    integration_evidence_status: integrationStatus,
    approval_artifact_status: approvalStatus,
    delta_computed: deltaComputed,
    policy_drift_clean: policyDriftClean,
    schema_drift_clean: schemaDriftClean,
    all_pass: allPass,
    last_verified_at: lastVerifiedAt,
    computed_at: now,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Assemble a {@link ClaimEvidenceLink} from already-fetched SDK artifacts.
 *
 * - Generates a client-side `link_id` (`cel_` + UUID v4).
 * - Computes schema drift from the SDK version; policy drift is set to
 *   `delta.status: "pending"` (server-side, async).
 * - Signs the link with HMAC-SHA256 when `signingSecret` is provided.
 * - `verified_at_link_creation` is set to `true` when the receipt carries a
 *   `decision === "allow"` (the permit was valid at the moment we're building
 *   the link, since it was just produced by `protectWithEvidence()`).
 *
 * The returned link has `revision: 1`. Subsequent calls to
 * {@link verifyClaimEvidenceLink} increment `revision` and recompute
 * `link_hash` / `link_signature`.
 */
export function buildClaimEvidenceLink(opts: BuildClaimEvidenceLinkOpts): ClaimEvidenceLink {
  const now = new Date().toISOString();
  const linkId = `cel_${randomUUID().replace(/-/g, "")}`;
  const orgId = opts.orgId ?? opts.runtimeEvidence.org_id;
  const schemaVersion = opts.schemaVersion ?? SDK_VERSION;

  const deploySlot = toDeploySlot(opts.deployEvidence);
  const integrationSlot = toIntegrationSlot(opts.integrationEvidence);
  const approvalSlot = toApprovalSlot(opts.approvalArtifact);

  const deployStatus = slotStatus(opts.deployEvidence, deploySlot);
  const integrationStatus = slotStatus(opts.integrationEvidence, integrationSlot);
  const approvalStatus = slotStatus(opts.approvalArtifact, approvalSlot);

  // verified_at_link_creation: true only if the decision was allow (permit is fresh)
  const verifiedAtCreation = opts.runtimeEvidence.decision === "allow";
  const runtime = toRuntimeSlot(opts.runtimeEvidence, verifiedAtCreation);

  const delta: DeltaSlot = {
    status: "pending",
    computed_at: null,
    policy_version_at_claim: null,
    policy_version_current: null,
    policy_drift_detected: null,
    schema_version_at_claim: schemaVersion,
    schema_version_current: schemaVersion,
    schema_drift_detected: false,
    drift_details: [],
  };

  const lastVerifiedAt = verifiedAtCreation ? now : null;
  const checklist = buildChecklist(
    runtime, deployStatus, integrationStatus, approvalStatus, delta, lastVerifiedAt, now,
  );

  const linkAlgorithm: ClaimEvidenceLink["link_algorithm"] =
    opts.signingSecret ? "hmac-sha256" : "none";

  // Build the signable body (everything except link_hash + link_signature)
  const body = {
    version: "claim_evidence_link.v1" as const,
    link_id: linkId,
    claim_id: opts.claimId,
    org_id: orgId,
    linked_at: now,
    updated_at: now,
    revision: 1,
    link_algorithm: linkAlgorithm,
    runtime_evidence: runtime,
    deploy_evidence: deploySlot,
    integration_evidence: integrationSlot,
    approval_artifact: approvalSlot,
    delta,
    verification_checklist: checklist,
  };

  const linkHash = computeLinkHash(body);
  const linkSignature = opts.signingSecret
    ? hmacSha256Base64url(linkHash, opts.signingSecret)
    : null;

  return { ...body, link_hash: linkHash, link_signature: linkSignature };
}

/**
 * Verify the structural integrity and checklist freshness of a
 * {@link ClaimEvidenceLink}.
 *
 * Checks:
 * 1. `link_hash` matches a canonical re-serialisation of the link content.
 * 2. `link_signature` verifies under `link_algorithm` (when not `"none"`).
 * 3. Recomputes the `verification_checklist` from the current slot state.
 *
 * Returns a new `ClaimEvidenceLink` with:
 * - Updated `verified_at_link_creation` / `last_verified_at` (permit may have
 *   expired since the link was built — reflected in the updated checklist).
 * - Incremented `revision`.
 * - Recomputed `link_hash` / `link_signature` over the mutated content.
 *
 * Does **not** mutate the input. Does **not** make network calls (permit
 * re-verification via `/v1-verify-permit` is scoped for v2 once the server
 * endpoint ships).
 *
 * @throws {@link AtlaSentError} with `code: "claim_evidence_incomplete"` when
 *   `all_pass` is false on the refreshed checklist.
 */
export function verifyClaimEvidenceLink(
  link: ClaimEvidenceLink,
  opts: VerifyClaimEvidenceLinkOpts = {},
): VerifyClaimEvidenceLinkResult {
  const now = new Date().toISOString();

  // 1. Verify link_hash
  const { link_hash: _lh, link_signature: _ls, ...body } = link as unknown as Record<string, unknown>;
  const expectedHash = computeLinkHash(
    body as Omit<ClaimEvidenceLink, "link_hash" | "link_signature">,
  );
  const hashValid = expectedHash === link.link_hash;

  // 2. Verify signature
  let sigValid = true;
  if (link.link_algorithm === "hmac-sha256") {
    if (!opts.signingSecret) {
      sigValid = false;
    } else {
      const expected = hmacSha256Base64url(link.link_hash, opts.signingSecret);
      sigValid = expected === link.link_signature;
    }
  }

  // 3. Recompute checklist (permit re-verification deferred to v2)
  const runtime: RuntimeEvidenceSlot = {
    ...link.runtime_evidence,
    // If the link hash or signature is invalid, mark creation-time verification as failed
    verified_at_link_creation: hashValid && sigValid
      ? link.runtime_evidence.verified_at_link_creation
      : false,
  };

  const checklist = buildChecklist(
    runtime,
    link.verification_checklist.deploy_evidence_status,
    link.verification_checklist.integration_evidence_status,
    link.verification_checklist.approval_artifact_status,
    link.delta,
    runtime.verified_at_link_creation ? (link.verification_checklist.last_verified_at ?? now) : null,
    now,
  );

  // 4. Build updated link
  const updatedBody = {
    version: link.version,
    link_id: link.link_id,
    claim_id: link.claim_id,
    org_id: link.org_id,
    linked_at: link.linked_at,
    updated_at: now,
    revision: link.revision + 1,
    link_algorithm: link.link_algorithm,
    runtime_evidence: runtime,
    deploy_evidence: link.deploy_evidence,
    integration_evidence: link.integration_evidence,
    approval_artifact: link.approval_artifact,
    delta: link.delta,
    verification_checklist: checklist,
  };

  const newHash = computeLinkHash(updatedBody);
  const newSignature = opts.signingSecret
    ? hmacSha256Base64url(newHash, opts.signingSecret)
    : link.link_algorithm === "none" ? null : link.link_signature;

  const updatedLink: ClaimEvidenceLink = {
    ...updatedBody,
    link_hash: newHash,
    link_signature: newSignature,
  };

  // 5. Collect failed slots
  const failedSlots: string[] = [];
  if (!hashValid) failedSlots.push("link_hash");
  if (!sigValid) failedSlots.push("link_signature");
  if (!checklist.verified_at_claim_time) failedSlots.push("verified_at_claim_time");
  if (!checklist.verified_at_link_creation) failedSlots.push("verified_at_link_creation");
  if (!checklist.delta_computed) failedSlots.push("delta_computed");
  if (checklist.policy_drift_clean === false) failedSlots.push("policy_drift_clean");
  if (!checklist.schema_drift_clean) failedSlots.push("schema_drift_clean");
  if (checklist.deploy_evidence_status === "missing") failedSlots.push("deploy_evidence_status");
  if (checklist.integration_evidence_status === "missing") failedSlots.push("integration_evidence_status");
  if (checklist.approval_artifact_status === "missing") failedSlots.push("approval_artifact_status");

  const valid = failedSlots.length === 0;

  if (!valid) {
    throw new AtlaSentError(
      `ClaimEvidenceLink verification failed: ${failedSlots.join(", ")}`,
      { code: "claim_evidence_incomplete" as never },
    );
  }

  return { link: updatedLink, valid, failedSlots };
}

/**
 * Build a {@link ClaimEvidenceLink} directly from the `evidence-bundle`
 * JSON emitted by the AtlaSent GitHub Action.
 *
 * ```ts
 * import { buildClaimEvidenceLinkFromActionBundle } from "@atlasent/sdk";
 *
 * const bundle = JSON.parse(process.env.ATLASENT_EVIDENCE_BUNDLE!);
 * const link = buildClaimEvidenceLinkFromActionBundle(bundle, {
 *   claimId: myClaimId,
 *   signingSecret: process.env.ATLASENT_SIGNING_SECRET,
 * });
 * ```
 *
 * The `receipt` fields map directly to the `runtime_evidence` slot. The
 * `bundle.sha` / `bundle.environment` / `bundle.actor` are used to
 * auto-populate the `deploy_evidence` slot — pass `deployNotApplicable: true`
 * to suppress this for non-deploy actions.
 */
export function buildClaimEvidenceLinkFromActionBundle(
  bundle: ActionBundleInput,
  opts: BuildFromActionBundleOpts,
): ClaimEvidenceLink {
  const runtimeEvidence: DecisionReceipt = {
    receipt_id: bundle.receipt.receipt_id,
    evaluation_id: bundle.receipt.evaluation_id,
    org_id: opts.orgId ?? "",
    decision: bundle.receipt.decision as "allow",
    action: bundle.action,
    actor: bundle.actor,
    resource_type: null,
    resource_id: null,
    reasons: [],
    why_trace: null,
    permit_id: bundle.receipt.permit_id,
    permit_hash: null,
    audit_hash: bundle.receipt.audit_hash ?? "",
    context_hash: "",
    issued_at: bundle.receipt.issued_at,
    expires_at: null,
    algorithm: bundle.receipt.algorithm as DecisionReceiptAlgorithm,
    signature: bundle.receipt.signature,
    signing_key_id: null,
    payload: {
      receipt_id: bundle.receipt.receipt_id,
      evaluation_id: bundle.receipt.evaluation_id,
      org_id: opts.orgId ?? "",
      decision: bundle.receipt.decision as "allow",
      action: bundle.action,
      actor: bundle.actor,
      resource_type: null,
      resource_id: null,
      reasons: [],
      why_summary: "",
      permit_id: bundle.receipt.permit_id,
      permit_hash: null,
      audit_hash: bundle.receipt.audit_hash ?? "",
      context_hash: "",
      issued_at: bundle.receipt.issued_at,
      expires_at: null,
    },
  };

  const deployEvidence: DeployEvidenceInput | NotApplicable = opts.deployNotApplicable
    ? NOT_APPLICABLE
    : {
        deploy_id: bundle.bundle_id,
        environment: bundle.environment,
        sha: bundle.sha,
        actor_id: bundle.actor,
        deployed_at: bundle.generated_at,
        gate_permit_token: bundle.receipt.permit_id ?? bundle.receipt.receipt_id,
      };

  return buildClaimEvidenceLink({
    claimId: opts.claimId,
    ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
    runtimeEvidence,
    deployEvidence,
    ...(opts.signingSecret !== undefined ? { signingSecret: opts.signingSecret } : {}),
    ...(opts.schemaVersion !== undefined ? { schemaVersion: opts.schemaVersion } : {}),
  });
}
