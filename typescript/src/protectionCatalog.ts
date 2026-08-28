import { z } from "zod";

const nonEmpty = z.string().min(1);
const relativeRef = nonEmpty.refine(
  (value) => !value.startsWith("/") && !value.includes(".."),
  "expected a repository-relative reference",
);
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const canonId = z.string().regex(/^CANON-[0-9]{6}$/);
const actionId = z.string().regex(/^ACT-[0-9]{4}$/);
const packId = z.string().regex(/^AP-[0-9]{6}$/);
const bindingProfileId = z.string().regex(/^BP-[0-9]{6}$/);
const slug = z.string().regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const semver = z.string().regex(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

const uniqueValues = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(schema).superRefine((values, ctx) => {
    if (new Set(values).size !== values.length) {
      ctx.addIssue({ code: "custom", message: "array values must be unique" });
    }
  });

export const CatalogNavigationSchema = z.object({
  semantics: z.literal("discovery-only"),
  role_terms_grant_authority: z.literal(false),
  industries: uniqueValues(nonEmpty),
  departments: uniqueValues(nonEmpty),
  roles: uniqueValues(nonEmpty),
  systems: uniqueValues(nonEmpty),
  environments: uniqueValues(nonEmpty),
  buyers: uniqueValues(nonEmpty),
}).strict();

export const CatalogClassificationSchema = CatalogNavigationSchema.extend({
  actor_categories: uniqueValues(z.enum(["human", "ai_agent", "service_account"])),
}).strict();

const exactActionRefSchema = z.object({
  canon_id: canonId,
  act_id: actionId,
  slug,
}).strict();

const exactScopeEvidenceSchema = z.object({
  evidence_refs: uniqueValues(relativeRef).min(1),
  evidence_cutoff: nonEmpty,
  exact_scope: z.object({
    action_refs: z.array(exactActionRefSchema).min(1),
    system_binding_profile_refs: uniqueValues(bindingProfileId).min(1),
    environments: uniqueValues(nonEmpty).min(1),
    resource_scope_refs: uniqueValues(relativeRef).min(1),
  }).strict(),
}).strict();

export const ActionPackMaturitySchema = z.object({
  definition_status: z.enum(["draft", "proposed", "active", "deprecated"]),
  surface_tier: z.enum(["GA", "Beta", "Experimental", "Internal"]),
  implementation_status: z.enum([
    "contract_only",
    "implementation_in_progress",
    "production_shaped",
    "runtime_integrated",
  ]),
  proof_rung: z.enum([
    "internally_proven",
    "customer_accepted",
    "production_validated",
  ]).nullable(),
  proof_evidence_refs: uniqueValues(relativeRef),
  proof_evidence_cutoff: nonEmpty.nullable(),
  customer_acceptance: z.enum(["not_started", "in_progress", "accepted", "revoked"]),
  customer_acceptance_evidence: exactScopeEvidenceSchema.nullable(),
  eligible_lifecycle_modes: uniqueValues(z.enum(["shadow", "advisory", "enforced"])).min(1),
}).strict().superRefine((maturity, ctx) => {
  if (maturity.proof_rung === null) {
    if (maturity.proof_evidence_refs.length !== 0 || maturity.proof_evidence_cutoff !== null) {
      ctx.addIssue({ code: "custom", message: "proof evidence cannot exist without a proof rung" });
    }
  } else if (maturity.proof_evidence_refs.length === 0 || maturity.proof_evidence_cutoff === null) {
    ctx.addIssue({ code: "custom", message: "a proof rung requires dated evidence" });
  }

  const accepted = maturity.customer_acceptance === "accepted";
  const acceptanceProof = maturity.proof_rung === "customer_accepted" || maturity.proof_rung === "production_validated";
  if ((accepted || acceptanceProof) && (!accepted || !acceptanceProof || maturity.customer_acceptance_evidence === null)) {
    ctx.addIssue({ code: "custom", message: "customer acceptance and exact-scope proof must agree" });
  }

  if (maturity.eligible_lifecycle_modes.includes("enforced") && (
    maturity.implementation_status !== "runtime_integrated" ||
    !accepted ||
    !acceptanceProof ||
    maturity.customer_acceptance_evidence === null
  )) {
    ctx.addIssue({ code: "custom", message: "enforced eligibility requires runtime integration and accepted exact-scope proof" });
  }

  if (maturity.surface_tier === "GA" && (
    maturity.implementation_status !== "runtime_integrated" ||
    maturity.proof_rung !== "production_validated" ||
    !accepted ||
    maturity.customer_acceptance_evidence === null
  )) {
    ctx.addIssue({ code: "custom", message: "GA requires production validation and accepted exact-scope proof" });
  }
});

const readinessGateSchema = z.object({
  status: z.enum(["not_started", "in_progress", "met", "not_applicable", "blocked"]),
  evidence_refs: uniqueValues(relativeRef),
  notes: nonEmpty,
}).strict().superRefine((gate, ctx) => {
  if (gate.status === "met" && gate.evidence_refs.length === 0) {
    ctx.addIssue({ code: "custom", message: "a met readiness gate requires evidence" });
  }
});

export const BindingProofSchema = z.object({
  highest_demonstrated_level: z.enum(["L0", "L1", "L2", "L3", "L4", "L5"]),
  evidence_refs: uniqueValues(relativeRef),
  readiness_gates: z.object({
    G1_access: readinessGateSchema,
    G2_security: readinessGateSchema,
    G3_behavior: readinessGateSchema,
    G4_customer_acceptance: readinessGateSchema,
    G5_production: readinessGateSchema,
  }).strict(),
  customer_acceptance: z.object({
    status: z.enum(["not_started", "in_progress", "accepted", "revoked"]),
    evidence_refs: uniqueValues(relativeRef),
    exact_scope_evidence: exactScopeEvidenceSchema.nullable(),
  }).strict(),
}).strict().superRefine((proof, ctx) => {
  if (proof.customer_acceptance.status === "accepted" && (
    proof.customer_acceptance.evidence_refs.length === 0 ||
    proof.customer_acceptance.exact_scope_evidence === null
  )) {
    ctx.addIssue({ code: "custom", message: "accepted binding proof requires exact-scope evidence" });
  }
});

export const SystemBindingProfileSchema = z.object({
  system_binding_profile_id: bindingProfileId,
  display_name: nonEmpty,
  source_system: nonEmpty,
  execution_system: nonEmpty,
  observation_system: nonEmpty,
  covered_path: nonEmpty,
  boundary_status: z.enum(["planned", "direct_provider_only", "provider_boundary", "customer_accepted"]),
  enforcement_boundary: nonEmpty,
  action_coverage: z.array(z.object({
    canon_id: canonId,
    act_id: actionId,
    slug,
    mutation_operation: nonEmpty,
    observation_operation: nonEmpty,
  }).strict()).min(1),
  proof: BindingProofSchema,
}).strict();

const packMembershipSchema = z.object({
  pack_id: packId,
  pack_version: semver,
  relationship: z.enum(["primary", "supporting", "triggered"]),
  maturity: ActionPackMaturitySchema,
  binding_profile_refs: uniqueValues(bindingProfileId),
  fresh_authorization_required: z.literal(true).optional(),
}).strict();

export const ProtectionCatalogActionSchema = z.object({
  canon_id: canonId,
  act_id: actionId,
  slug,
  display_name: nonEmpty,
  description: nonEmpty,
  family: nonEmpty,
  risk_posture: nonEmpty,
  ai_risk: nonEmpty,
  safeguard_action_refs: uniqueValues(z.string().regex(/^SG-ACT-[0-9]{3}$/)),
  classification: CatalogClassificationSchema,
  pack_memberships: z.array(packMembershipSchema),
}).strict();

const versionHistorySchema = z.object({
  version: semver,
  state: z.enum(["draft", "proposed", "released", "deprecated"]),
  recorded_at: nonEmpty,
  change_summary: nonEmpty,
  source_refs: uniqueValues(relativeRef).min(1),
  content_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict().superRefine((entry, ctx) => {
  const immutable = entry.state === "released" || entry.state === "deprecated";
  if (immutable !== (entry.content_sha256 !== null)) {
    ctx.addIssue({ code: "custom", message: "only immutable versions carry content SHA-256" });
  }
});

const roleHomeSchema = z.object({
  role_category: z.enum([
    "executive_buyer",
    "organization_admin",
    "requester_operator",
    "approver_authority_holder",
    "auditor_observer",
    "integration_owner",
    "support",
  ]),
  role_term: nonEmpty,
  home_id: nonEmpty,
  primary_need: nonEmpty,
  authority_semantics: z.literal("navigation-only"),
}).strict();

const participationSchema = z.object({
  actor_categories: uniqueValues(z.enum(["human", "ai_agent", "service_account"])).min(1),
  description: nonEmpty,
  authority_semantics: z.literal("participation-only"),
}).strict();

const lifecycleSchema = z.object({
  authorization_decisions: z.tuple([
    z.literal("allow"),
    z.literal("deny"),
    z.literal("hold"),
    z.literal("escalate"),
  ]),
  execution_refusal_state: z.literal("refused"),
  permit_signed: z.literal(true),
  permit_short_lived: z.literal(true),
  permit_exact_bound: z.literal(true),
  permit_single_use: z.literal(true),
  facts_reread_immediately_before_execution: z.literal(true),
  permit_verified_and_atomically_consumed_at_last_responsible_moment: z.literal(true),
  denied_or_refused_causes_zero_provider_mutation_calls: z.literal(true),
  milestones: z.tuple([
    z.literal("AUTHORIZED"),
    z.literal("EXECUTED"),
    z.literal("OBSERVED"),
    z.literal("EFFECT_ESTABLISHED"),
  ]),
  rollback_requires_fresh_protected_action: z.literal(true),
  revoke_requires_fresh_protected_action: z.literal(true),
  adoption_requires_fresh_protected_action: z.literal(true),
}).strict();

const actionPackActionSchema = z.object({
  canon_id: canonId,
  act_id: actionId,
  slug,
  relationship: z.enum(["primary", "supporting", "triggered"]),
  car_ref: relativeRef,
  fresh_authorization_required: z.literal(true).optional(),
  safeguard_action_refs: uniqueValues(z.string().regex(/^SG-ACT-[0-9]{3}$/)).optional(),
  specialization_refs: uniqueValues(slug).optional(),
}).strict();

export const ActionPackSchema = z.object({
  pack_id: packId,
  slug,
  version: semver,
  version_history: z.array(versionHistorySchema).min(1),
  display_name: nonEmpty,
  summary: nonEmpty,
  status: z.enum(["draft", "proposed", "active", "deprecated"]),
  source_refs: uniqueValues(relativeRef).min(1),
  purpose: z.object({
    economic_owner_terms: uniqueValues(nonEmpty).min(1),
    urgent_job: nonEmpty,
    promised_outcome: nonEmpty,
    exclusions: uniqueValues(nonEmpty).min(1),
  }).strict(),
  experience: z.object({
    role_homes: z.array(roleHomeSchema).min(1),
    shared_journey: uniqueValues(nonEmpty).min(1),
    required_states: uniqueValues(nonEmpty).min(1),
  }).strict(),
  fact_binding_requirements: z.object({
    actor: uniqueValues(nonEmpty).min(1),
    authority: uniqueValues(nonEmpty).min(1),
    action: uniqueValues(nonEmpty).min(1),
    target: uniqueValues(nonEmpty).min(1),
    payload: uniqueValues(nonEmpty).min(1),
    policy: uniqueValues(nonEmpty).min(1),
    permit: uniqueValues(nonEmpty).min(1),
    effect: uniqueValues(nonEmpty).min(1),
  }).strict(),
  commercial: z.object({
    offer_ref: relativeRef,
    expansion_units: uniqueValues(z.enum([
      "action_class",
      "system_provider",
      "environment_business_unit",
      "resource_coverage",
      "evidence_availability",
      "overlay",
    ])).min(1),
  }).strict(),
  composition: z.object({
    reference_only: z.literal(true),
    canonical_fields_inlined: z.literal(false),
    specialization_semantics_inlined: z.literal(false),
    overlay_policy: z.literal("additive-only"),
  }).strict(),
  actions: z.array(actionPackActionSchema).min(1),
  actor_participation: z.object({
    requester: participationSchema,
    resolver: participationSchema,
    executor: participationSchema,
  }).strict(),
  actor_authority: z.object({
    authority_template_refs: uniqueValues(relativeRef).min(1),
    organization_constitution_required: z.literal(true),
    required_human_resolution_not_machine_substitutable: z.literal(true),
    role_navigation_grants_authority: z.literal(false),
    system_identity_grants_authority: z.literal(false),
    requester_identity_self_authorizes: z.literal(false),
  }).strict(),
  navigation: CatalogNavigationSchema,
  maturity: ActionPackMaturitySchema,
  lifecycle_contract: lifecycleSchema,
  binding_profiles: z.array(SystemBindingProfileSchema).min(1),
  dependencies: z.object({
    required_refs: z.array(z.object({
      kind: z.enum(["canon-record", "safeguard-action", "authority-template", "specialization", "system-binding-profile"]),
      id: nonEmpty,
      ref: relativeRef,
    }).strict()),
    optional_future_capability_refs: uniqueValues(z.string().regex(/^[A-Z][A-Z0-9]*-[0-9]+$/)),
  }).strict(),
  claims: z.object({
    allowed: z.array(z.object({
      claim_code: z.enum([
        "ACTION_PACK_CONTRACT_DRAFTED",
        "DIRECT_PROVIDER_BOUNDARY_DEFINED",
        "PRODUCTION_SHAPED_IMPLEMENTATION_DOCUMENTED",
      ]),
      evidence_refs: uniqueValues(relativeRef).min(1),
      cutoff: nonEmpty,
    }).strict()),
    prohibited: z.array(z.object({
      claim_code: z.enum([
        "GEARSET_NATIVE_ENFORCEMENT_ESTABLISHED",
        "SALTO_NETSUITE_ENFORCEMENT_ESTABLISHED",
        "GOOGLE_BINDING_READINESS_ESTABLISHED",
        "CUSTOMER_ACCEPTANCE_EARNED",
        "PRODUCTION_VALIDATION_EARNED",
      ]),
      reason: nonEmpty,
    }).strict()),
  }).strict(),
}).strict();

export const FutureCapabilityFlagsSchema = z.object({
  activatable: z.literal(false),
  commercially_claimable: z.literal(false),
  required_dependency_eligible: z.literal(false),
  has_authority: z.literal(false),
  runtime_authorized: z.literal(false),
  implementation_authorized: z.literal(false),
}).strict();

export const FutureCapabilitySchema = z.object({
  capability_id: z.string().regex(/^[A-Z][A-Z0-9]*-[0-9]+$/),
  display_name: nonEmpty,
  summary: nonEmpty,
  source_refs: uniqueValues(relativeRef).min(1),
  contract_state: z.enum(["draft", "accepted"]),
  build_state: z.enum(["planned", "schema_implemented", "implementation_deferred"]),
  availability_horizon: z.literal("future"),
  disclosure_state: z.literal("gated"),
  flags: FutureCapabilityFlagsSchema,
}).strict();

const pathDigestSchema = z.object({ path: relativeRef, sha256 }).strict();
const sourceDigestsSchema = z.object({
  canonical_registry: sha256,
  canonical_action_records: sha256,
  action_pack_registry: sha256,
  safeguard_actions: sha256,
  safeguard_index: sha256,
  future_capability_registry: sha256,
  catalog_config: sha256,
  specialization_registry: sha256,
  action_pack_schema: sha256,
  future_capability_schema: sha256,
  protection_catalog_schema: sha256,
  generator: sha256,
  protection_catalog_readme: sha256,
  referenced_evidence_sources: sha256,
}).strict();

export const ProtectionCatalogSchema = z.object({
  schema_version: z.literal("1.0"),
  kind: z.literal("protection-catalog"),
  catalog_version: nonEmpty,
  released_at: nonEmpty,
  evidence_cutoff: nonEmpty,
  source_digests: sourceDigestsSchema,
  generation_provenance: z.object({
    generator: pathDigestSchema,
    schemas: z.object({
      action_pack: pathDigestSchema,
      future_capability: pathDigestSchema,
      protection_catalog: pathDigestSchema,
    }).strict(),
    source_manifest: z.array(pathDigestSchema).min(1),
  }).strict(),
  summary: z.object({
    active_canonical_action_count: z.number().int().positive(),
    action_pack_count: z.number().int().positive(),
    future_capability_count: z.number().int().positive(),
  }).strict(),
  actions: z.array(ProtectionCatalogActionSchema).min(1),
  action_packs: z.array(ActionPackSchema).min(1),
  future_capabilities: z.array(FutureCapabilitySchema).min(1),
}).strict().superRefine((catalog, ctx) => {
  if (catalog.summary.active_canonical_action_count !== catalog.actions.length) {
    ctx.addIssue({ code: "custom", path: ["summary", "active_canonical_action_count"], message: "summary/action count mismatch" });
  }
  if (catalog.summary.action_pack_count !== catalog.action_packs.length) {
    ctx.addIssue({ code: "custom", path: ["summary", "action_pack_count"], message: "summary/pack count mismatch" });
  }
  if (catalog.summary.future_capability_count !== catalog.future_capabilities.length) {
    ctx.addIssue({ code: "custom", path: ["summary", "future_capability_count"], message: "summary/future count mismatch" });
  }

  const triples = catalog.actions.map((action) => `${action.canon_id}/${action.act_id}/${action.slug}`);
  if (new Set(triples).size !== triples.length) {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "canonical action triples must be unique" });
  }

  const rollback = catalog.actions.find((action) => action.slug === "production.rollback");
  if (!rollback || rollback.canon_id !== "CANON-000031" || rollback.act_id !== "ACT-0034") {
    ctx.addIssue({ code: "custom", path: ["actions"], message: "production rollback Canon triple drifted" });
  }
});

export type ProtectionCatalog = z.infer<typeof ProtectionCatalogSchema>;
export type ProtectionCatalogAction = z.infer<typeof ProtectionCatalogActionSchema>;
export type ActionPack = z.infer<typeof ActionPackSchema>;
export type ActionPackMaturity = z.infer<typeof ActionPackMaturitySchema>;
export type SystemBindingProfile = z.infer<typeof SystemBindingProfileSchema>;
export type BindingProof = z.infer<typeof BindingProofSchema>;
export type FutureCapability = z.infer<typeof FutureCapabilitySchema>;
export type FutureCapabilityFlags = z.infer<typeof FutureCapabilityFlagsSchema>;
export type CatalogNavigation = z.infer<typeof CatalogNavigationSchema>;

/** Parse an untrusted API response without synthesizing missing catalog truth. */
export function parseProtectionCatalog(value: unknown): ProtectionCatalog {
  return ProtectionCatalogSchema.parse(value);
}

/** Safe counterpart for adapters that need to render an explicit unavailable state. */
export function safeParseProtectionCatalog(value: unknown) {
  return ProtectionCatalogSchema.safeParse(value);
}
