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
  /** Permanent immutable identifier (CANON-NNNNNN). Stable across slug changes. */
  canon_id: string;
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
    canon_id: 'CANON-000001',
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
    canon_id: 'CANON-000002',
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
    canon_id: 'CANON-000003',
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
    canon_id: 'CANON-000004',
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
    canon_id: 'CANON-000005',
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
    canon_id: 'CANON-000006',
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
    canon_id: 'CANON-000007',
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
    canon_id: 'CANON-000008',
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
    canon_id: 'CANON-000009',
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
    canon_id: 'CANON-000010',
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
    canon_id: 'CANON-000011',
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
    canon_id: 'CANON-000012',
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
    canon_id: 'CANON-000013',
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
    canon_id: 'CANON-000014',
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
    canon_id: 'CANON-000015',
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
    canon_id: 'CANON-000016',
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
    canon_id: 'CANON-000017',
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
  TRIAL_UNBLINDING_EXECUTE: {
    id: 'ACT-0021',
    canon_id: 'CANON-000018',
    slug: 'trial.unblinding.execute',
    family: 'clinical.trial',
    display_name: 'Clinical Trial Unblinding',
    description: `Authorization gate for clinical trial unblinding — the irreversible act of revealing randomized treatment assignments to investigators, sponsors, and/or analysts. Unblinding compromises the statistical integrity of ongoing blinded trials and constitutes a regulated consequential transition requiring maximum controls: dual authorization, MFA, a verified human actor, and cryptographic proof of regulatory scope, actor identity, and explicit approval assertion. No AI system or automated process may execute unblinding. Regulatory basis: ICH E6(R2) §4.8.2, 21 CFR Part 11 §11.50/§11.300, EU Annex 11 §7.1.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: true,
      required_assertion_classes: ['regulatory', 'identity', 'approval'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'human-only',
      machine_executable: false,
      minimum_approvals: 2,
    },
    sdk_constant: 'TRIAL_UNBLINDING_EXECUTE',
    use_case: `Gate clinical trial unblinding behind dual human authorization, phishing-resistant MFA, and a cryptographically verified actor — so a sponsor can prove to the FDA or EMA that the blind was broken only by named, authorized humans with a signed, offline-verifiable audit record and an explicit §11.50 signature meaning.`,
    industries: ['pharma', 'biotech', 'cro', 'medical-device', 'healthtech'],
  },
  TRIAL_BLINDING_SETUP: {
    id: 'ACT-0022',
    canon_id: 'CANON-000019',
    slug: 'trial.blinding.setup',
    family: 'clinical.trial',
    display_name: 'Clinical Trial Blind Establishment',
    description: `Authorization gate for establishing the blind in a clinical trial — the act of sealing randomization codes, binding treatment assignments to subject IDs, and activating the blinded-data enforcement state in trial management systems (RTSM/IVRS). Blinding setup is the prerequisite that makes trial.unblinding.execute irreversible once executed; errors at setup time (wrong randomization list, incorrect stratum assignments) propagate through the entire trial. Only sponsor-designated blinding authority roles may authorize blind establishment. Requires a verified identity, supervisor review of the randomization specification, a cryptographic snapshot of the randomization list hash, and a complete audit trail per 21 CFR Part 11 §11.10(a) and EU Annex 11 §7.1. Machine callers may not execute blinding setup without explicit organizational override.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: ['identity'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'approval-chain',
      machine_executable: false,
      minimum_approvals: 1,
    },
    sdk_constant: 'TRIAL_BLINDING_SETUP',
    use_case: `Gate establishment of the trial blind behind a verified blinding authority, supervisor review, and a sealed cryptographic snapshot of the randomization list — so the sponsor has a tamper-evident anchor proving the list was fixed before enrolment and unchanged at unblinding time.`,
    industries: ['pharma', 'biotech', 'cro', 'medical-device'],
  },
  TRIAL_UNBLINDING_EMERGENCY: {
    id: 'ACT-0023',
    canon_id: 'CANON-000020',
    slug: 'trial.unblinding.emergency',
    family: 'clinical.trial',
    display_name: 'Emergency Clinical Trial Unblinding',
    description: `Authorization gate for emergency single-patient unblinding in a clinical trial — the act of breaking the blind for a specific subject when knowledge of their treatment assignment is required for immediate medical decision-making (e.g., a Serious Adverse Event requiring the treating physician to know whether the patient received drug or placebo). Emergency unblinding is per-subject, not a full trial unblinding, and must be performed by the principal investigator or site physician responsible for the subject's safety. Requires a single authorized human approver (the treating physician), a documented medical emergency justification, MFA for the authorizing physician, and an immediate audit record. The blind is broken for one subject only — other subjects remain blinded and the trial may continue. Regulatory basis: ICH E6(R2) §4.8.2–3, ICH E9 §6.5, 21 CFR Part 11 §11.300, EU Annex 11 §14.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: false,
      required_assertion_classes: ['identity', 'approval'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'human-only',
      machine_executable: false,
      minimum_approvals: 1,
    },
    sdk_constant: 'TRIAL_UNBLINDING_EMERGENCY',
    use_case: `Gate emergency single-subject unblinding behind one cryptographically verified treating physician with MFA and a documented medical justification — so a site can act fast in a medical emergency while still producing a signed, offline-verifiable record scoped to the one subject, with the sponsor notified immediately.`,
    industries: ['pharma', 'biotech', 'cro', 'hospital-research'],
  },
  FINANCE_PAYMENT_AUTHORIZE: {
    id: 'ACT-0024',
    canon_id: 'CANON-000021',
    slug: 'finance.payment.authorize',
    family: 'finance.payment',
    display_name: 'High-Value Payment Authorization',
    description: `Authorization gate for releasing a payment above an organization's auto-approval threshold — an ACH batch, card settlement, or ERP payment run. High-value payments carry direct financial-loss and fraud exposure, so release must be gated behind two-person integrity with separation of duties: the caller who initiates a payment cannot be the caller who approves it. Every release binds a tamper-evident permit to the amount, counterparty, and account, giving auditors a machine-checkable four-eyes record. Regulatory basis: SOX §404, PCI DSS v4.0, NIST SP 800-53 AC-5.`,
    risk_posture: 'critical',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: true,
      required_assertion_classes: ['approval'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'four-eyes',
      machine_executable: false,
      minimum_approvals: 2,
    },
    sdk_constant: 'FINANCE_PAYMENT_AUTHORIZE',
    use_case: `Gate every high-value payment behind two-person integrity with separation of duties and a tamper-evident permit bound to the amount and counterparty — so a controller can prove to an auditor that no single person, and no bot, released funds unauthorized.`,
    industries: ['fintech', 'banking', 'enterprise', 'insurance'],
  },
  FINANCE_WIRE_TRANSFER: {
    id: 'ACT-0025',
    canon_id: 'CANON-000022',
    slug: 'finance.wire.transfer',
    family: 'finance.payment',
    display_name: 'High-Value Wire Transfer',
    description: `Authorization gate for releasing a high-value or cross-border wire (SWIFT / Fedwire). Wires are fast and irreversible, making them the highest-consequence money movement an organization performs and a prime target for business-email-compromise fraud. Release must be gated behind two-person integrity, phishing-resistant MFA for the releasing caller, and a cryptographically verified actor identity — a self-asserted actor_id is not sufficient. The permit binds the beneficiary and amount so the authorization cannot be reused for a different payee. Regulatory basis: SOX §404, SWIFT CSP v2024, NIST SP 800-53 IA-2/AC-5.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: true,
      required_assertion_classes: ['approval', 'identity'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'four-eyes',
      machine_executable: false,
      minimum_approvals: 2,
    },
    sdk_constant: 'FINANCE_WIRE_TRANSFER',
    use_case: `Gate high-value and cross-border wires behind two-person integrity, phishing-resistant MFA, and a verified actor, with the beneficiary bound into the permit — so treasury can prove no single person, no unverified identity, and no bot released an irreversible wire.`,
    industries: ['banking', 'fintech', 'enterprise', 'insurance'],
  },
  INDUSTRIAL_CONTROL_ACTUATE: {
    id: 'ACT-0026',
    canon_id: 'CANON-000023',
    slug: 'industrial.control.actuate',
    family: 'industrial.control',
    display_name: 'Industrial Control Actuation',
    description: `Authorization gate for a consequential command to a physical-process controller — a breaker or switch operation on a power grid, a valve or pump actuation on a pipeline, or a control setpoint change on a DCS/PLC. These commands have direct physical, safety, and reliability consequences, so they are gated at an OT control gateway that sits between the operator's HMI and the field device, outside the real-time safety loop. Release requires two-person integrity, phishing-resistant MFA, and a state snapshot of the command and target device tag. An unverified or automated caller never reaches the actuator. Regulatory basis: NERC CIP-004/007/010, IEC 62443-3-3 SR 1.1/2.1.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: true,
      required_assertion_classes: ['approval', 'identity'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'human-only',
      machine_executable: false,
      minimum_approvals: 2,
    },
    sdk_constant: 'INDUSTRIAL_CONTROL_ACTUATE',
    use_case: `Gate consequential OT control commands — breaker operations, valve actuations, setpoint changes — behind two-person integrity, MFA, and a verified operator at a control gateway, so a utility or operator can prove every physical command was authorized by named, trained personnel with a signed, offline-verifiable record.`,
    industries: ['energy', 'utilities', 'oil-and-gas', 'manufacturing', 'water'],
  },
  HEALTHCARE_RECORD_AMEND: {
    id: 'ACT-0027',
    canon_id: 'CANON-000024',
    slug: 'healthcare.record.amend',
    family: 'healthcare.record',
    display_name: 'Patient Health Record Amendment',
    description: `Authorization gate for amending a finalized (signed) patient health record in an EHR — an addendum or correction to a closed encounter note. A finalized clinical record is a legal document; amending it must preserve the original, attribute the change to a verified clinician with a treatment relationship, and capture the reason. The gate requires a cryptographically verified actor (a self-asserted actor_id from a hospital system is not sufficient), human approval, and a state snapshot that preserves the pre-amendment record. Regulatory basis: HIPAA Security Rule §164.312, 21 CFR Part 11 §11.10(e), ISO 27799.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: true,
      requires_state_snapshot: true,
      required_assertion_classes: ['identity'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'approval-chain',
      machine_executable: false,
      minimum_approvals: 1,
    },
    sdk_constant: 'HEALTHCARE_RECORD_AMEND',
    use_case: `Gate amendments to finalized patient records behind a cryptographically verified clinician, human approval, and a snapshot that preserves the original — so a provider can prove to an auditor or regulator that every change to a legal health record was attributable, reasoned, and integrity-preserving.`,
    industries: ['healthtech', 'hospital-systems', 'payers', 'life-sciences'],
  },
  IDENTITY_PRIVILEGED_GRANT: {
    id: 'ACT-0028',
    canon_id: 'CANON-000025',
    slug: 'identity.privileged.grant',
    family: 'identity.access',
    display_name: 'Privileged Access Grant',
    description: `Authorization gate for granting privileged or administrative access — writing an elevated entitlement into an IdP, PAM vault, or directory. Privileged access can dissolve every other control, so the grant itself is a governed action: it requires human approval, phishing-resistant MFA for the approver, and a cryptographically verified actor. The grant is time-boxed via the permit so it can auto-revert on expiry. Regulatory basis: NIST SP 800-53 AC-6, ISO/IEC 27001 A.8.2, SOC 2 CC6.1.`,
    risk_posture: 'critical',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: false,
      required_assertion_classes: ['identity', 'approval'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'approval-chain',
      machine_executable: false,
      minimum_approvals: 1,
    },
    sdk_constant: 'IDENTITY_PRIVILEGED_GRANT',
    use_case: `Make privileged access itself a governed action — every admin grant requires human approval, phishing-resistant MFA, and a verified approver, with a time-boxed permit that auto-reverts. A security team can prove exactly who granted what elevated access, to whom, for how long, and with what approval.`,
    industries: ['saas', 'fintech', 'enterprise', 'healthtech', 'government'],
  },
  AGENT_TOOL_INVOKE: {
    id: 'ACT-0029',
    canon_id: 'CANON-000026',
    slug: 'agent.tool.invoke',
    family: 'agent.execute',
    display_name: 'Agent Tool Invocation',
    description: `Authorization gate for an autonomous AI agent invoking a tool, function, or downstream action at execution time. The agent's asserted identity is not trusted on its own — a self-declared actor_id can be spoofed — so the request must carry a cryptographically verified actor identity before the tool runs. This is the flagship execution-time authorization surface: every agent action is gated, permitted, and audited before it touches a real system.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: false,
      requires_mfa: false,
      requires_verified_actor: true,
      requires_state_snapshot: false,
      required_assertion_classes: ['identity', 'risk'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'role-only',
      machine_executable: true,
    },
    sdk_constant: 'AGENT_TOOL_INVOKE',
    use_case: `Gate every autonomous agent tool call behind a verifiable permit so you can prove which agent did what, under what verified identity, and at what risk — the enforcement layer AI agent frameworks lack.`,
    industries: ['saas', 'fintech', 'enterprise', 'regulated-industries'],
  },
  MODEL_PROMOTE: {
    id: 'ACT-0030',
    canon_id: 'CANON-000027',
    slug: 'model.promote',
    family: 'agent.execute',
    display_name: 'Model Promotion',
    description: `Authorization gate for promoting an AI/ML model to a production-serving environment. Promoting a model is a consequential transition: an unvetted or tampered model can make autonomous decisions at scale. Promotion requires human approval, a verified actor, a bound snapshot of the exact model artifact, and a model-trust assertion establishing the base model and evaluation provenance before a permit is issued.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: true,
      requires_state_snapshot: true,
      required_assertion_classes: ['model_trust', 'identity'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'approval-chain',
      machine_executable: false,
      minimum_approvals: 1,
    },
    sdk_constant: 'MODEL_PROMOTE',
    use_case: `Gate every model promotion behind human approval, a bound model snapshot, and a model-trust assertion so you can prove which model reached production and who authorized it.`,
    industries: ['saas', 'fintech', 'healthtech', 'regulated-industries'],
  },
  DATA_EXPORT: {
    id: 'ACT-0031',
    canon_id: 'CANON-000028',
    slug: 'data.export',
    family: 'data.release',
    display_name: 'Bulk Data Export',
    description: `Authorization gate for exporting a bulk dataset out of a system of record — a data-egress transition with high privacy and compliance blast radius. A large export of personal data can breach residency obligations or consent scope. Export requires human approval and verified residency and consent assertions before a permit is issued, and direct-identifier fields are denied unless explicitly permitted.`,
    risk_posture: 'high',
    ai_risk: 'High',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: false,
      requires_verified_actor: false,
      requires_state_snapshot: false,
      required_assertion_classes: ['residency', 'consent'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'approval-chain',
      machine_executable: false,
      minimum_approvals: 1,
    },
    sdk_constant: 'DATA_EXPORT',
    use_case: `Gate every bulk data export behind human approval and verified residency/consent scope so you can prove no dataset left the boundary without authorization and lawful basis.`,
    industries: ['fintech', 'healthtech', 'saas', 'regulated-industries'],
  },
  SECURITY_BREAKGLASS: {
    id: 'ACT-0032',
    canon_id: 'CANON-000029',
    slug: 'security.breakglass',
    family: 'security.exception',
    display_name: 'Break-Glass Access',
    description: `Authorization gate for emergency break-glass access — an intentional, time-bounded exception that grants elevated privilege during an incident. Break-glass is the most abused path in any system, so it is the most heavily gated: it requires a verified human actor, multi-factor authentication, an explicit approval artifact, and a bound snapshot of the incident context. A machine can never invoke it. Every use produces a tamper-evident permit for post-incident review.`,
    risk_posture: 'critical',
    ai_risk: 'Extreme',
    gate_flags: {
      requires_human_approval: true,
      requires_mfa: true,
      requires_verified_actor: true,
      requires_state_snapshot: true,
      required_assertion_classes: ['identity', 'risk'] as AssertionClass[],
    },
    authorization_pattern: {
      type: 'human-only',
      machine_executable: false,
    },
    sdk_constant: 'SECURITY_BREAKGLASS',
    use_case: `Gate every break-glass escalation behind verified identity, MFA, and human approval so each emergency privilege grant is attributable, time-bounded, and provable in post-incident review.`,
    industries: ['fintech', 'healthtech', 'saas', 'enterprise', 'regulated-industries'],
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

/** Look up a catalog entry by permanent canon_id (e.g. "CANON-000001"). The
 *  canon_id is stable across slug changes — prefer it for durable references. */
export function getActionByCanonId(canonId: string): ActionCatalogEntry | undefined {
  return Object.values(ACTION_CATALOG).find(a => a.canon_id === canonId);
}

/** Return all catalog entries as an array. */
export function listActions(): ActionCatalogEntry[] {
  return Object.values(ACTION_CATALOG);
}
