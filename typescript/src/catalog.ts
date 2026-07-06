// GENERATED FILE — do not edit directly.
// Source: contract/canonical-actions/ACT-*.yaml (generator v1.0)
// Regenerate: python3 scripts/generate-from-canon.py
//
// This file is synced to atlasent-sdk/typescript/src/catalog.ts by the
// canon-sync CI workflow. Do not hand-edit either copy.

/** Canonical risk classification. */
export type RiskPosture = 'low' | 'standard' | 'high' | 'critical';

/** AI-specific risk from the Authorization Intelligence Library. */
export type AiRisk = 'Low' | 'Medium' | 'High' | 'Extreme';

/** Authorization pattern type. */
export type AuthorizationPatternType =
  | 'four-eyes'
  | 'role-only'
  | 'quorum'
  | 'approval-chain'
  | 'any-role'
  | 'human-only';

/** Assertion classes recognized by the runtime. */
export type AssertionClass =
  | 'identity' | 'approval' | 'sensitivity' | 'risk' | 'device'
  | 'location' | 'budget' | 'residency' | 'regulatory'
  | 'model_trust' | 'prompt_risk' | 'supply_chain' | 'consent';

/** Per-action runtime gate flags. */
export interface ActionGateFlags {
  requires_human_approval: boolean;
  requires_mfa: boolean;
  requires_verified_actor: boolean;
  requires_state_snapshot: boolean;
  required_assertion_classes: AssertionClass[];
}

/** Single entry in the Authorization Intelligence Library catalog. */
export interface ActionCatalogEntry {
  id: string;
  slug: string;
  family: string;
  display_name: string;
  description: string;
  risk_posture: RiskPosture;
  ai_risk: AiRisk;
  gate_flags: ActionGateFlags;
  authorization_pattern: {
    type: AuthorizationPatternType;
    machine_executable: boolean;
    minimum_approvals?: number;
  };
  sdk_constant: string;
  use_case: string;
  industries: string[];
}

export const ACTION_CATALOG = {
  PRODUCTION_DEPLOY: {
    id: 'ACT-0001',
    slug: 'production.deploy',
    family: 'production.deploy',
    display_name: 'Production Deploy',
    description: `Authorization gate for deploying code, configuration, or infrastructure to a production environment. Production deployments carry high blast radius — an unauthorized or insufficiently-reviewed change can cause outages, data corruption, or security exposure across all customers. Every deploy must be traceable to a tamper-evident permit with an auditable approval chain.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'four-eyes',
      machine_executable: false,
      minimum_approvals: 2,
    },
    sdk_constant: 'PRODUCTION_DEPLOY',
    use_case: `Gate every production deployment behind a tamper-evident permit with named approvers, change window enforcement, and an offline-verifiable audit chain — so auditors can prove who authorized what, when, and with what evidence.`,
    industries: ['fintech', 'healthtech', 'saas', 'enterprise', 'regulated-industries'],
  },
  ARTIFACT_RELEASE: {
    id: 'ACT-0002',
    slug: 'artifact.release',
    family: 'production.deploy',
    display_name: 'Artifact Release',
    description: `Authorization gate for publishing a versioned artifact to a public or private distribution channel — npm, PyPI, crates.io, Docker Hub, Maven Central, GitHub Releases, or any package registry. Once published, an artifact is consumed by downstream systems; a malicious or compromised release propagates silently through the supply chain. Requires cryptographically verified actor identity to close the spoofed-actor attack surface.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: true,
      requires_state_snapshot: true,
      required_assertion_classes: ['supply_chain'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'ARTIFACT_RELEASE',
    use_case: `Prevent unauthorized or compromised actors from publishing packages to npm, PyPI, crates.io, or any registry. Every release is gated behind a cryptographically verified actor identity and a supply chain assertion binding the artifact hash.`,
    industries: ['saas', 'developer-tools', 'fintech', 'enterprise', 'open-source'],
  },
  WORKFLOW_APPROVE: {
    id: 'ACT-0003',
    slug: 'workflow.approve',
    family: 'production.deploy',
    display_name: 'Workflow Approval',
    description: `Authorization gate for recording a human approval decision within a multi-step workflow. An approval is definitionally a human act — it attests that a qualified person reviewed content and authorizes progression. Machine-generated approvals are not approvals; they are automated checks. This action requires a human actor to prevent AI systems from self-approving workflow steps they participate in — the AI self-approval loop that regulators are now mandating controls for.`,
    risk_posture: 'standard',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: false,
    },
    sdk_constant: 'WORKFLOW_APPROVE',
    use_case: `Prevent AI agents from approving their own outputs or advancing workflows they participate in. Every workflow approval is gated to verified human actors — closing the AI self-approval loop that regulators are now requiring controls for.`,
    industries: ['fintech', 'healthtech', 'regulated-industries', 'enterprise', 'legal'],
  },
  DATA_MODIFY: {
    id: 'ACT-0005',
    slug: 'data.modify',
    family: 'data.access',
    display_name: 'Data Modification',
    description: `Authorization gate for modifications to regulated, critical, or shared data. Data modifications have broad downstream effects — corrupted records in healthcare, financial, or compliance contexts can propagate silently and are difficult to reverse. State snapshot binding captures the pre-modification state, enabling rollback evidence and satisfying reason-for-change requirements under 21 CFR Part 11 §11.10(e).`,
    risk_posture: 'standard',
    ai_risk: 'Medium',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'DATA_MODIFY',
    use_case: `Gate all modifications to regulated data (PHI, financial records, clinical trial data) with actor attribution, state snapshots, and reason-for-change capture — satisfying FDA, HIPAA, and GDPR audit trail requirements.`,
    industries: ['healthtech', 'fintech', 'life-sciences', 'regulated-industries'],
  },
  DATA_IMPORT: {
    id: 'ACT-0007',
    slug: 'data.import',
    family: 'data.access',
    display_name: 'Data Import',
    description: `Authorization gate for ingesting external data into regulated or production systems — ETL pipelines, third-party data feeds, clinical trial data imports, financial data onboarding, and AI training data ingestion. Imported data can introduce corruption, malicious content, or unvalidated records into clean systems. State snapshot binding captures the source dataset hash, satisfying data provenance requirements under 21 CFR Part 11 and HIPAA.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'DATA_IMPORT',
    use_case: `Gate all data imports from external sources — clinical trial data, financial feeds, third-party vendors — with integrity verification and authorization permits that prove what was imported, by whom, and from where.`,
    industries: ['healthtech', 'life-sciences', 'fintech', 'enterprise'],
  },
  DATA_DELETE: {
    id: 'ACT-0008',
    slug: 'data.delete',
    family: 'data.access',
    display_name: 'Data Deletion',
    description: `Authorization gate for deletion of regulated, irreplaceable, or legally significant data. Deletions are irreversible in most systems; unauthorized deletion can result in permanent data loss, GDPR erasure obligation violations (proving deletion happened), and destruction of records required to be retained under SOX or HIPAA. State snapshot binding captures what existed at deletion time for erasure certificates and retention audits.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'DATA_DELETE',
    use_case: `Gate all data deletions with documented authorization, state snapshots, and reason capture — creating erasure certificates for GDPR Art. 17 compliance and preventing AI agents from autonomously deleting production data.`,
    industries: ['saas', 'fintech', 'healthtech', 'enterprise', 'regulated-industries'],
  },
  ACCESS_GRANT: {
    id: 'ACT-0009',
    slug: 'access.grant',
    family: 'identity.grant',
    display_name: 'Access Grant',
    description: `Authorization gate for granting privileged access — IAM roles, group memberships, elevated permissions, API key provisioning, and service account grants. Access grants are the most consequential identity operation: they expand the privilege surface permanently until revoked. Unauthorized grants enable privilege escalation, lateral movement, and persistent access for attackers. Requires human approval and quorum to prevent unilateral privilege escalation.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'quorum',
      machine_executable: false,
      minimum_approvals: 2,
    },
    sdk_constant: 'ACCESS_GRANT',
    use_case: `Enforce two-person integrity for all privileged access grants — IAM roles, group memberships, elevated permissions. Every grant requires human approval with a documented business justification and a tamper-evident audit chain.`,
    industries: ['fintech', 'healthtech', 'enterprise', 'regulated-industries', 'saas'],
  },
  ACCESS_REVOKE: {
    id: 'ACT-0010',
    slug: 'access.revoke',
    family: 'identity.grant',
    display_name: 'Access Revocation',
    description: `Authorization gate for revoking access — removing IAM roles, group memberships, elevated permissions, or deprovisioning accounts. Unlike access grants, revocations are often time-critical during security incidents; requiring human approval would delay incident response. Instead, this action gates revocations with role verification and an immutable audit trail, ensuring every revocation is attributed and documented without blocking the speed needed for offboarding or incident containment.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'ACCESS_REVOKE',
    use_case: `Create an immutable audit trail for every access revocation — offboarding, incident response, role changes — without slowing down the revocation speed needed during security incidents.`,
    industries: ['fintech', 'healthtech', 'enterprise', 'regulated-industries'],
  },
  CONTROL_OVERRIDE: {
    id: 'ACT-0011',
    slug: 'control.override',
    family: 'privileged.operation',
    display_name: 'Control Override',
    description: `Authorization gate for bypassing a security or compliance control — break-glass access, policy exceptions, emergency overrides, firewall rule bypasses, and regulatory exemptions. Control overrides are the highest-risk action class: they deliberately disable a protective control, creating a window of elevated risk. Every override must be justified, attributed to a verified human actor with MFA, and the risk must be contemporaneously assessed. AI agents must never override security controls autonomously.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: false,
      required_assertion_classes: ['risk', 'identity'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'approval-chain',
      machine_executable: false,
    },
    sdk_constant: 'CONTROL_OVERRIDE',
    use_case: `Gate every security control override — break-glass access, emergency bypasses, policy exceptions — with MFA, verified identity, human approval, and a contemporaneous risk assessment. Every override is permanently attributed and auditable.`,
    industries: ['fintech', 'healthtech', 'enterprise', 'regulated-industries', 'government'],
  },
  CONTENT_PUBLISH: {
    id: 'ACT-0013',
    slug: 'content.publish',
    family: 'regulated.release',
    display_name: 'Content Publication',
    description: `Authorization gate for publishing regulated content — medical device documentation, IFUs, SOPs, labeling, regulatory submissions, clinical study reports, and controlled documents. In regulated industries, a document released without proper authorization constitutes a quality system non-conformance. State snapshot binding captures the document hash at publication time, enabling version traceability.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'CONTENT_PUBLISH',
    use_case: `Gate publication of all regulated documents — medical device IFUs, SOPs, labeling, clinical study reports — with document hash binding and author attribution, creating a tamper-evident record of every controlled document release.`,
    industries: ['life-sciences', 'healthtech', 'medtech', 'regulated-industries'],
  },
  IDENTITY_SIGN: {
    id: 'ACT-0014',
    slug: 'identity.sign',
    family: 'identity.grant',
    display_name: 'Identity Signature',
    description: `Authorization gate for electronic signature acts — signing regulated documents, certifying records, and affixing a legally significant identity to a decision. Electronic signatures are legal acts requiring human intent under 21 CFR Part 11, EU eIDAS, and the US eSign Act. This action structurally prevents machine execution: no AI agent, service account, or automated system can sign on behalf of a human. Requires MFA and identity + approval assertions to bind the signer's identity to the signature act.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: ['identity', 'approval'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'human-only',
      machine_executable: false,
    },
    sdk_constant: 'IDENTITY_SIGN',
    use_case: `Gate all regulated electronic signature acts — batch release certifications, clinical study reports, SOX officer certifications, EU AI Act conformity declarations — with MFA and identity assertions that prove a verified human (not AI) signed.`,
    industries: ['life-sciences', 'healthtech', 'fintech', 'regulated-industries', 'legal'],
  },
  RESOURCE_CREATE: {
    id: 'ACT-0015',
    slug: 'resource.create',
    family: 'infrastructure.change',
    display_name: 'Resource Creation',
    description: `Authorization gate for creation of cloud resources, databases, infrastructure components, and managed services. Resource creation is the origin point of all infrastructure; without attribution at creation time, the lineage of production resources is opaque. State snapshot binding captures the desired configuration at authorization time, preventing configuration drift between approval and provisioning.`,
    risk_posture: 'standard',
    ai_risk: 'Low',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'RESOURCE_CREATE',
    use_case: `Attribute every cloud resource creation to an authorized actor with a configuration hash — preventing shadow IT, enabling asset lifecycle governance, and satisfying SOX and ISO 27001 change management requirements.`,
    industries: ['saas', 'enterprise', 'fintech', 'regulated-industries'],
  },
  RESOURCE_DESTROY: {
    id: 'ACT-0016',
    slug: 'resource.destroy',
    family: 'infrastructure.change',
    display_name: 'Resource Destruction',
    description: `Authorization gate for irreversible destruction of cloud resources, databases, storage buckets, and infrastructure components. Resource destruction is one of the highest-risk infrastructure operations — a mistaken or unauthorized destroy can cause catastrophic data loss, extended outages, and regulatory violations. Requires the strongest gate: human approval, MFA, verified actor identity, and a contemporaneous risk assessment proving the actor understood the consequences before proceeding.`,
    risk_posture: 'critical',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: false,
      required_assertion_classes: ['risk', 'identity'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'quorum',
      machine_executable: false,
      minimum_approvals: 2,
    },
    sdk_constant: 'RESOURCE_DESTROY',
    use_case: `Prevent catastrophic data loss from unauthorized or mistaken infrastructure destruction. Every destroy operation requires two human approvers with MFA, verified identities, and a contemporaneous risk assessment — no AI agent or solo admin can destroy production resources.`,
    industries: ['fintech', 'healthtech', 'enterprise', 'saas', 'regulated-industries'],
  },
  SERVICE_SUSPEND: {
    id: 'ACT-0017',
    slug: 'service.suspend',
    family: 'infrastructure.change',
    display_name: 'Service Suspension',
    description: `Authorization gate for deliberate suspension of a production service — taking a service offline for maintenance, as an incident response action, or as a business decision. Service suspension has direct customer impact through SLA obligations and availability commitments. State snapshot binding captures the pre-suspension service state, enabling documented justification and post-suspension comparison.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'SERVICE_SUSPEND',
    use_case: `Document every deliberate service suspension with actor attribution, service state snapshot, and justification — creating the governance record needed for SLA compliance and post-incident reviews.`,
    industries: ['saas', 'fintech', 'enterprise', 'regulated-industries'],
  },
  SERVICE_RESUME: {
    id: 'ACT-0018',
    slug: 'service.resume',
    family: 'infrastructure.change',
    display_name: 'Service Resumption',
    description: `Authorization gate for resuming a suspended service — bringing a service back online after planned or emergency maintenance. Service resumption carries its own risks: resuming a service before the underlying issue is resolved can cause immediate re-failure. State snapshot binding captures the post-fix service configuration, enabling documented validation that the root cause was addressed before resumption.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'SERVICE_RESUME',
    use_case: `Document every service resumption with actor attribution, post-fix configuration state, and root cause summary — creating the SLA restoration evidence and post-incident closure record that compliance and customers require.`,
    industries: ['saas', 'fintech', 'enterprise'],
  },
  WORKFLOW_ESCALATE: {
    id: 'ACT-0019',
    slug: 'workflow.escalate',
    family: 'production.deploy',
    display_name: 'Workflow Escalation',
    description: `Authorization gate for workflow escalation steps — capturing the moment when an AI agent, automated system, or human acknowledges it cannot proceed without additional authority and escalates to a higher-level decision maker. Escalation is intentionally low-friction (any-role, no human approval gate) because the goal is to capture and attribute escalations, not to gate them. A well-documented escalation trail proves AI agents recognized their limits and deferred to humans rather than proceeding autonomously.`,
    risk_posture: 'standard',
    ai_risk: 'Low',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: [] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'any-role',
      machine_executable: true,
    },
    sdk_constant: 'WORKFLOW_ESCALATE',
    use_case: `Create an audit trail of every escalation event — proving AI agents recognized their limits and deferred to humans rather than proceeding autonomously. The escalation chain becomes evidence of appropriate human-AI collaboration.`,
    industries: ['saas', 'enterprise', 'regulated-industries', 'fintech', 'healthtech'],
  },
  COMPLIANCE_CERTIFY: {
    id: 'ACT-0020',
    slug: 'compliance.certify',
    family: 'regulated.release',
    display_name: 'Compliance Certification',
    description: `Authorization gate for compliance certification acts — EU AI Act declarations of conformity, SOX §302 CEO/CFO certifications, GxP Qualified Person batch release certifications, HIPAA compliance officer certifications, and ISO/IEC conformity attestations. These are legal acts performed by a qualified authority with personal accountability. No AI system may certify compliance on behalf of a human — this action is structurally machine-blocked. Requires MFA, a qualified human authority, and regulatory + identity + approval assertions proving the certifier understood and accepted the obligations they are certifying.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: ['regulatory', 'identity', 'approval'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'human-only',
      machine_executable: false,
    },
    sdk_constant: 'COMPLIANCE_CERTIFY',
    use_case: `Gate all compliance certification acts — EU AI Act conformity declarations, SOX §302 certifications, GxP QP batch releases, HIPAA compliance evaluations — with a verified human qualified authority, MFA, and regulatory + identity + approval assertions that prove a natural person certified, not an AI system.`,
    industries: ['life-sciences', 'fintech', 'regulated-industries', 'enterprise', 'healthtech'],
  },
} as const satisfies Record<string, ActionCatalogEntry>;

/** All canonical action catalog keys. */
export type ActionCatalogKey = keyof typeof ACTION_CATALOG;

/** Canonical action ID string (e.g. "ACT-0001"). */
export type ActionId = string;

/** Canonical action slug string (e.g. "production.deploy"). */
export type ActionSlug = string;

/** All canonical action slugs. */
export const ACTION_SLUGS = Object.values(ACTION_CATALOG).map(a => a.slug) as ActionSlug[];

/** Look up a catalog entry by slug. Returns undefined if not found. */
export function getActionBySlug(slug: string): ActionCatalogEntry | undefined {
  return Object.values(ACTION_CATALOG).find(a => a.slug === slug);
}

/** Look up a catalog entry by ID (e.g. "ACT-0001"). Returns undefined if not found. */
export function getActionById(id: string): ActionCatalogEntry | undefined {
  return Object.values(ACTION_CATALOG).find(a => a.id === id);
}

/** Return all catalog entries as an array. */
export function listActions(): ActionCatalogEntry[] {
  return Object.values(ACTION_CATALOG);
}
