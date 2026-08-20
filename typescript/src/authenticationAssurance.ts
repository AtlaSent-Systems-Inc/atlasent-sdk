/**
 * Authentication assurance evidence/requirement types — CROSS-016
 * (atlasent-docs architecture/adr/CROSS-016-assurance-aware-authorization.md)
 * as landed in atlasent's contract/proposals/0003-authentication-assurance-evidence-and-requirement.md.
 *
 * SDK-side re-export. Wire-contract authority is
 * `atlasent/packages/types/src/authentication-assurance-v1.ts`; this module
 * mirrors it byte-for-byte (interfaces, validators, and the tri-state
 * `matchesResourceContextCondition` helper) so `@atlasent/sdk` consumers get
 * the same shapes without depending on the contract-types package directly.
 * Matches `atlasent/contract/schemas/authentication-assurance.v1.schema.json`.
 *
 * ADDITIVE, NOT YET ENFORCED: the companion resolver
 * (atlasent-api's `supabase/functions/_shared/assurance_resolver.ts`) is
 * deliberately shadow-first and is not wired into `/v1-evaluate` yet
 * (CROSS-016 §10) — no wire endpoint carries these shapes today, so this
 * module is intentionally absent from `contract/tools/drift.py` (which only
 * tracks the live `/v1-evaluate` / `/v1-verify-permit` / v2 request-response
 * bodies). Same reasoning applies to `contextEnvelope.ts`.
 */

/** What was proved at authentication time. Never contains a requirement. */
export interface AuthenticationAssuranceEvidence {
  methods: MethodProvenance[];
  factor_count: number;
  phishing_resistant: boolean;
  /** RFC 3339 date-time. */
  auth_time: string;
  /** Absolute URI identifying the issuer. */
  issuer: string;
  verification_status: "verified" | "unverified" | "unknown";
  capability_summary: string[];
}

export interface MethodProvenance {
  method: string;
  issuer: string;
  verified: boolean;
}

/** CROSS-016 §4's registry contract for a single predicate. */
export interface PredicateRegistryEntry {
  id: string;
  semantics: string;
  value_type: "scalar" | "boolean" | "set";
  evaluation: "min" | "max" | "intersection" | "exact";
  version: number;
  /** Always 'hold' — CROSS-016 §7 makes this non-negotiable, not a per-predicate choice. */
  unknown_handling: "hold";
}

export interface PredicateInstance {
  predicate_id: string;
  value: unknown;
}

/**
 * v1 closed condition vocabulary for resource/context matching (proposal
 * 0003 §1). `field` is a registered CDO context-field identifier,
 * never an arbitrary JSON path. `eq` requires a scalar value; `in` requires
 * a homogeneous non-empty scalar array. An unknown field, a type mismatch,
 * or unavailable context must resolve to `hold` at evaluation time, never
 * to "condition false" — same fail-closed posture as every other undecided
 * case in this contract. Conditions within one requirement are conjunctive.
 */
export interface ResourceContextCondition {
  field: string;
  operator: "eq" | "in";
  value: string | number | boolean | string[] | number[] | boolean[];
}

/** CROSS-016 §5's four-layer default, deliberately distinct from PolicyLayer. */
export type AssuranceRequirementLayer =
  | "external_obligation"
  | "organization"
  | "action_class"
  | "resource_context";

/**
 * What one source demands. A real discriminated union on `layer`:
 * `source_type` is required for `external_obligation` (distinguishing the
 * two DB sources, proposal 0003 §2) and structurally absent otherwise.
 * `when` conditions are optional for `action_class` and required (at least
 * one) for an independently authored `resource_context` source.
 */
export type AuthenticationAssuranceRequirement =
  | {
      layer: "external_obligation";
      source_type: "regime_profile" | "contractual_constraint";
      source_id: string;
      predicates: PredicateInstance[];
      effective_from: string;
      effective_until?: string | null;
    }
  | {
      layer: "organization";
      source_id: string;
      predicates: PredicateInstance[];
      effective_from: string;
      effective_until?: string | null;
    }
  | {
      layer: "action_class";
      source_id: string;
      predicates: PredicateInstance[];
      when?: ResourceContextCondition[];
      effective_from: string;
      effective_until?: string | null;
    }
  | {
      layer: "resource_context";
      source_id: string;
      predicates: PredicateInstance[];
      when: ResourceContextCondition[];
      effective_from: string;
      effective_until?: string | null;
    };

/** The composed result of CROSS-016 §6's conjunction over every applicable requirement. */
export interface EffectiveAuthenticationAssuranceRequirement {
  predicates: Record<
    string,
    {
      value: unknown;
      /** Full-provenance requirement — never collapse to one "winner". */
      contributing_sources: string[];
      decisive_sources: string[];
    }
  >;
}

/** Closed code vocabulary for non-allow assurance outcomes (proposal 0003 §4). */
export type AuthenticationAssuranceOutcomeCode =
  | "ASSURANCE_APPLICABILITY_UNDETERMINED"
  | "ASSURANCE_EVIDENCE_MISSING"
  | "ASSURANCE_ISSUER_UNTRUSTED"
  | "ASSURANCE_EVIDENCE_UNVERIFIED"
  | "ASSURANCE_EVIDENCE_SOURCE_CONFLICT"
  | "ASSURANCE_EVIDENCE_STALE"
  | "ASSURANCE_POLICY_CONFLICT"
  | "ASSURANCE_RESOLUTION_INDETERMINATE"
  | "ASSURANCE_REQUIREMENT_UNMET";

/**
 * CROSS-016 §7. Every outcome references its per-evaluation assurance
 * trace. Every non-allow outcome requires a typed code. `requirement_ref`
 * is present when resolution produced an effective requirement, but is
 * correctly absent for applicability/resolver failures that occur before
 * one exists.
 */
export type AssuranceEvaluationOutcome =
  | {
      result: "allow";
      code?: never;
      trace_ref: string;
      requirement_ref?: string;
      evidence_ref?: string;
    }
  | {
      result: "hold" | "deny";
      code: AuthenticationAssuranceOutcomeCode;
      trace_ref: string;
      requirement_ref?: string;
      evidence_ref?: string;
    };

/**
 * The umbrella resolution state persisted onto
 * `regulated_constraint_bundles.assurance_resolution_status` (proposal
 * 0003 §3, atlasent-api). `indeterminate` is what CROSS-016's Critical
 * Invariant requires on any resolver-internal failure — it must never be
 * silently `resolved`.
 */
export type AssuranceResolutionStatus = "resolved" | "indeterminate" | "conflict";

/** A single typed reason backing a `hold`/`deny` or an `indeterminate`/`conflict` status. */
export interface AssuranceResolutionReason {
  code: AuthenticationAssuranceOutcomeCode;
  predicate_id?: string;
  detail: string;
}

// ---------------------------------------------------------------------------
// Lightweight structural validators (no runtime-validation dependency —
// matches this SDK's zero-dependency convention for contract types, e.g.
// contextEnvelope.ts's validateResourceClassificationAssertion).
// ---------------------------------------------------------------------------

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isIso8601(x: unknown): x is string {
  return typeof x === "string" && ISO_8601.test(x);
}

/** Structural validation for AuthenticationAssuranceEvidence. Returns a list of problems (empty = valid). */
export function validateAuthenticationAssuranceEvidence(input: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(input)) {
    return ["input must be an object"];
  }
  const e = input;
  if (!Array.isArray(e.methods)) problems.push("methods must be an array");
  if (typeof e.factor_count !== "number" || !Number.isInteger(e.factor_count) || e.factor_count < 0) {
    problems.push("factor_count must be a non-negative integer");
  }
  if (typeof e.phishing_resistant !== "boolean") problems.push("phishing_resistant must be a boolean");
  if (!isIso8601(e.auth_time)) problems.push("auth_time must be an RFC 3339 date-time");
  if (typeof e.issuer !== "string" || e.issuer.length === 0) problems.push("issuer must be a non-empty string (absolute URI)");
  if (e.verification_status !== "verified" && e.verification_status !== "unverified" && e.verification_status !== "unknown") {
    problems.push("verification_status must be 'verified' | 'unverified' | 'unknown'");
  }
  if (!Array.isArray(e.capability_summary)) problems.push("capability_summary must be an array");
  return problems;
}

/** Structural validation for one AuthenticationAssuranceRequirement branch. Returns a list of problems (empty = valid). */
export function validateAuthenticationAssuranceRequirement(input: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(input)) {
    return ["input must be an object"];
  }
  const r = input;
  const layer = r.layer;
  if (layer !== "external_obligation" && layer !== "organization" && layer !== "action_class" && layer !== "resource_context") {
    return ["layer must be one of external_obligation | organization | action_class | resource_context"];
  }
  if (layer === "external_obligation") {
    if (r.source_type !== "regime_profile" && r.source_type !== "contractual_constraint") {
      problems.push("source_type is required and must be 'regime_profile' | 'contractual_constraint' when layer is external_obligation");
    }
  } else if (r.source_type !== undefined) {
    problems.push(`source_type must be absent when layer is ${String(layer)}`);
  }
  if (typeof r.source_id !== "string" || r.source_id.length === 0) problems.push("source_id must be a non-empty string");
  if (!Array.isArray(r.predicates)) problems.push("predicates must be an array");
  if (layer === "resource_context") {
    if (!Array.isArray(r.when) || r.when.length === 0) {
      problems.push("when must be a non-empty array when layer is resource_context");
    }
  } else if (r.when !== undefined && !Array.isArray(r.when)) {
    problems.push("when, when present, must be an array");
  }
  if (!isIso8601(r.effective_from)) problems.push("effective_from must be an RFC 3339 date-time");
  if (r.effective_until !== undefined && r.effective_until !== null && !isIso8601(r.effective_until)) {
    problems.push("effective_until, when present, must be null or an RFC 3339 date-time");
  }
  return problems;
}

/** Type guard: true when `input` is a well-formed AuthenticationAssuranceRequirement. */
export function isAuthenticationAssuranceRequirement(
  input: unknown,
): input is AuthenticationAssuranceRequirement {
  return validateAuthenticationAssuranceRequirement(input).length === 0;
}

const OUTCOME_CODES: ReadonlySet<string> = new Set<AuthenticationAssuranceOutcomeCode>([
  "ASSURANCE_APPLICABILITY_UNDETERMINED",
  "ASSURANCE_EVIDENCE_MISSING",
  "ASSURANCE_ISSUER_UNTRUSTED",
  "ASSURANCE_EVIDENCE_UNVERIFIED",
  "ASSURANCE_EVIDENCE_SOURCE_CONFLICT",
  "ASSURANCE_EVIDENCE_STALE",
  "ASSURANCE_POLICY_CONFLICT",
  "ASSURANCE_RESOLUTION_INDETERMINATE",
  "ASSURANCE_REQUIREMENT_UNMET",
]);

/** True when `code` is one of the nine registered ASSURANCE_* codes (proposal 0003 §4). */
export function isAuthenticationAssuranceOutcomeCode(
  code: unknown,
): code is AuthenticationAssuranceOutcomeCode {
  return typeof code === "string" && OUTCOME_CODES.has(code);
}

export type ResourceContextConditionMatch = "match" | "no_match" | "undetermined";

/**
 * Evaluates a single ResourceContextCondition against a flat context map.
 * A missing context key, or an `in` condition whose declared value isn't
 * actually an array, is `undetermined` — not `no_match`. A caller MUST
 * treat `undetermined` as `hold` (CROSS-016 §7); collapsing it into a plain
 * boolean `false` reads as "this condition doesn't apply" and can silently
 * drop a requirement from composition instead of holding on it.
 */
export function matchesResourceContextCondition(
  condition: ResourceContextCondition,
  context: Record<string, unknown>,
): ResourceContextConditionMatch {
  if (!(condition.field in context)) return "undetermined";
  const actual = context[condition.field];
  if (condition.operator === "eq") {
    return actual === condition.value ? "match" : "no_match";
  }
  // operator === "in"
  if (!Array.isArray(condition.value)) return "undetermined";
  const values: unknown[] = condition.value;
  return values.includes(actual) ? "match" : "no_match";
}
