/**
 * AtlaSent Authorization Canon — Action Catalog
 *
 * Generated from contract/canonical-actions/ in the atlasent monorepo.
 * Source of truth: https://github.com/AtlaSent-Systems-Inc/atlasent/tree/main/contract/canonical-actions
 *
 * IMPORTANT: Do not edit slugs or IDs — they are wire-format identifiers.
 * The action_type field in evaluate requests must match the slug exactly.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type RiskPosture = "low" | "standard" | "high" | "critical";
export type AiRisk = "Low" | "Medium" | "High" | "Extreme";
export type AuthorizationPatternType =
  | "four-eyes"
  | "role-only"
  | "quorum"
  | "approval-chain"
  | "any-role"
  | "human-only";

export interface ActionGateFlags {
  requiresHumanApproval: boolean;
  requiresMfa: boolean;
  requiresVerifiedActor: boolean;
  requiresStateSnapshot: boolean;
  requiredAssertionClasses: readonly string[];
}

export interface ActionCatalogEntry {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly description: string;
  readonly family: string;
  readonly riskPosture: RiskPosture;
  readonly aiRisk: AiRisk;
  readonly gateFlags: ActionGateFlags;
  readonly authorizationPattern: {
    readonly type: AuthorizationPatternType;
    readonly minimumApprovals?: number;
    readonly machineExecutable: boolean;
    readonly rationale: string;
  };
  readonly regulatoryFrameworks: readonly string[];
}

// ── Catalog ─────────────────────────────────────────────────────────────────

export const ACTION_CATALOG = {
  PRODUCTION_DEPLOY: {
    id: "ACT-0001",
    slug: "production.deploy",
    displayName: "Production Deploy",
    description:
      "Gate production code, configuration, and infrastructure deployments with tamper-evident permits and an auditable approval chain.",
    family: "production.deploy",
    riskPosture: "high",
    aiRisk: "High",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "four-eyes",
      minimumApprovals: 2,
      machineExecutable: true,
      rationale:
        "Two-person integrity prevents a single compromised account from deploying malicious code.",
    },
    regulatoryFrameworks: ["sox", "iso27001", "nist_800_53"],
  },
  ARTIFACT_RELEASE: {
    id: "ACT-0002",
    slug: "artifact.release",
    displayName: "Artifact Release",
    description:
      "Gate publishing of versioned artifacts to package registries and distribution channels.",
    family: "production.deploy",
    riskPosture: "high",
    aiRisk: "High",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: true,
      requiresStateSnapshot: true,
      requiredAssertionClasses: ["supply_chain"],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "Verified actor identity closes the spoofed-actor supply chain attack surface.",
    },
    regulatoryFrameworks: ["nist_800_53", "eu_ai_act"],
  },
  WORKFLOW_APPROVE: {
    id: "ACT-0003",
    slug: "workflow.approve",
    displayName: "Workflow Approval",
    description:
      "Record a human approval decision within a multi-step workflow. An approval is definitionally a human act.",
    family: "production.deploy",
    riskPosture: "standard",
    aiRisk: "Extreme",
    gateFlags: {
      requiresHumanApproval: true,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: false,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: false,
      rationale:
        "An approval is definitionally a human act. Machine callers are structurally rejected.",
    },
    regulatoryFrameworks: ["sox", "gdpr"],
  },
  DATA_MODIFY: {
    id: "ACT-0005",
    slug: "data.modify",
    displayName: "Data Modification",
    description:
      "Gate modifications to regulated or critical data with state snapshot binding and actor attribution.",
    family: "data.access",
    riskPosture: "standard",
    aiRisk: "Medium",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "State snapshot binds the permit to the pre-modification state, enabling rollback evidence.",
    },
    regulatoryFrameworks: ["gdpr", "hipaa", "21cfr_part_11"],
  },
  DATA_IMPORT: {
    id: "ACT-0007",
    slug: "data.import",
    displayName: "Data Import",
    description:
      "Gate ingestion of external data into regulated systems with integrity verification and actor attribution.",
    family: "data.access",
    riskPosture: "high",
    aiRisk: "High",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "Data integrity verification at import time prevents corrupted or unauthorized data from entering regulated systems.",
    },
    regulatoryFrameworks: ["hipaa", "21cfr_part_11", "gdpr"],
  },
  DATA_DELETE: {
    id: "ACT-0008",
    slug: "data.delete",
    displayName: "Data Deletion",
    description:
      "Gate deletion of regulated or irreplaceable data with documented authorization and state capture.",
    family: "data.access",
    riskPosture: "high",
    aiRisk: "High",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "State snapshot proves what existed at deletion time, satisfying GDPR Art.17 documentation and SOX retention compliance.",
    },
    regulatoryFrameworks: ["gdpr", "hipaa", "sox"],
  },
  ACCESS_GRANT: {
    id: "ACT-0009",
    slug: "access.grant",
    displayName: "Access Grant",
    description:
      "Gate privileged access grants with human approval and quorum requirements.",
    family: "identity.grant",
    riskPosture: "critical",
    aiRisk: "Extreme",
    gateFlags: {
      requiresHumanApproval: true,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "quorum",
      minimumApprovals: 2,
      machineExecutable: false,
      rationale:
        "Access grants are permanently expanding — two-person integrity prevents unilateral privilege escalation.",
    },
    regulatoryFrameworks: ["sox", "pci_dss", "hipaa", "nist_800_53"],
  },
  ACCESS_REVOKE: {
    id: "ACT-0010",
    slug: "access.revoke",
    displayName: "Access Revocation",
    description:
      "Gate access revocation with audit trail. Revocations must be fast — no human approval required to prevent blocking incident response.",
    family: "identity.grant",
    riskPosture: "critical",
    aiRisk: "Extreme",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "Revocations require speed during incidents. Role-only gates with audit trail satisfy compliance without blocking remediation.",
    },
    regulatoryFrameworks: ["nist_800_53", "sox"],
  },
  CONTROL_OVERRIDE: {
    id: "ACT-0011",
    slug: "control.override",
    displayName: "Control Override",
    description:
      "Gate security control bypasses (break-glass) with MFA, verified actor, human approval, and risk + identity assertions.",
    family: "privileged.operation",
    riskPosture: "critical",
    aiRisk: "Extreme",
    gateFlags: {
      requiresHumanApproval: true,
      requiresMfa: true,
      requiresVerifiedActor: true,
      requiresStateSnapshot: false,
      requiredAssertionClasses: ["risk", "identity"],
    },
    authorizationPattern: {
      type: "approval-chain",
      machineExecutable: false,
      rationale:
        "Break-glass events require the strongest possible evidence chain — MFA, verified actor, contemporaneous risk assessment, and identity attribution.",
    },
    regulatoryFrameworks: ["pci_dss", "sox", "nist_800_53"],
  },
  CONTENT_PUBLISH: {
    id: "ACT-0013",
    slug: "content.publish",
    displayName: "Content Publication",
    description:
      "Gate publication of regulated content — medical device documentation, labeling, SOPs, and regulated marketing materials.",
    family: "regulated.release",
    riskPosture: "high",
    aiRisk: "High",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "Document control for regulated content requires an authorized role and a content hash bound to the permit.",
    },
    regulatoryFrameworks: ["21cfr_part_11", "iso27001"],
  },
  IDENTITY_SIGN: {
    id: "ACT-0014",
    slug: "identity.sign",
    displayName: "Identity Signature",
    description:
      "Gate electronic signature acts for regulated documents. Requires human actor, MFA, and identity + approval assertions per 21 CFR Part 11, eIDAS, and eSign Act.",
    family: "identity.grant",
    riskPosture: "critical",
    aiRisk: "Extreme",
    gateFlags: {
      requiresHumanApproval: true,
      requiresMfa: true,
      requiresVerifiedActor: false,
      requiresStateSnapshot: false,
      requiredAssertionClasses: ["identity", "approval"],
    },
    authorizationPattern: {
      type: "human-only",
      machineExecutable: false,
      rationale:
        "Electronic signatures are legal acts requiring human intent. Machine execution is structurally prohibited.",
    },
    regulatoryFrameworks: ["21cfr_part_11", "eu_ai_act", "sox"],
  },
  RESOURCE_CREATE: {
    id: "ACT-0015",
    slug: "resource.create",
    displayName: "Resource Creation",
    description:
      "Gate creation of cloud resources, databases, and infrastructure components with attribution and state capture.",
    family: "infrastructure.change",
    riskPosture: "standard",
    aiRisk: "Low",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "Resource creation is the starting point for all infrastructure. Attribution at creation time prevents shadow IT.",
    },
    regulatoryFrameworks: ["sox", "iso27001"],
  },
  RESOURCE_DESTROY: {
    id: "ACT-0016",
    slug: "resource.destroy",
    displayName: "Resource Destruction",
    description:
      "Gate irreversible destruction of cloud resources, databases, or storage with quorum, MFA, verified actor, and risk + identity assertions.",
    family: "infrastructure.change",
    riskPosture: "critical",
    aiRisk: "High",
    gateFlags: {
      requiresHumanApproval: true,
      requiresMfa: true,
      requiresVerifiedActor: true,
      requiresStateSnapshot: false,
      requiredAssertionClasses: ["risk", "identity"],
    },
    authorizationPattern: {
      type: "quorum",
      minimumApprovals: 2,
      machineExecutable: false,
      rationale:
        "Irreversible destruction requires the strongest gate — two humans must agree, with MFA and verified identities.",
    },
    regulatoryFrameworks: ["hipaa", "gdpr", "sox"],
  },
  SERVICE_SUSPEND: {
    id: "ACT-0017",
    slug: "service.suspend",
    displayName: "Service Suspension",
    description:
      "Gate deliberate suspension of a service with attribution and impact state capture.",
    family: "infrastructure.change",
    riskPosture: "high",
    aiRisk: "High",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "Elevated role required for deliberate suspension. State snapshot proves what state the service was in at the decision point.",
    },
    regulatoryFrameworks: ["iso27001"],
  },
  SERVICE_RESUME: {
    id: "ACT-0018",
    slug: "service.resume",
    displayName: "Service Resumption",
    description:
      "Gate service resumption after suspension with validation check and attribution.",
    family: "infrastructure.change",
    riskPosture: "high",
    aiRisk: "High",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: true,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "role-only",
      machineExecutable: true,
      rationale:
        "Service resumption should be documented — the permit proves who restored service and at what time for SLA evidence.",
    },
    regulatoryFrameworks: ["iso27001"],
  },
  WORKFLOW_ESCALATE: {
    id: "ACT-0019",
    slug: "workflow.escalate",
    displayName: "Workflow Escalation",
    description:
      "Gate workflow escalation steps — ensures AI agents that recognize their limits create an audit trail when escalating to humans.",
    family: "production.deploy",
    riskPosture: "standard",
    aiRisk: "Low",
    gateFlags: {
      requiresHumanApproval: false,
      requiresMfa: false,
      requiresVerifiedActor: false,
      requiresStateSnapshot: false,
      requiredAssertionClasses: [],
    },
    authorizationPattern: {
      type: "any-role",
      machineExecutable: true,
      rationale:
        "Escalation is intentionally permissive — the goal is to capture that an escalation happened, not to gate it.",
    },
    regulatoryFrameworks: ["sox"],
  },
  COMPLIANCE_CERTIFY: {
    id: "ACT-0020",
    slug: "compliance.certify",
    displayName: "Compliance Certification",
    description:
      "Gate compliance certification acts — EU AI Act conformity declarations, SOX §302 certifications, GxP QP certifications. Requires qualified human authority, MFA, and regulatory + identity + approval assertions.",
    family: "regulated.release",
    riskPosture: "critical",
    aiRisk: "Extreme",
    gateFlags: {
      requiresHumanApproval: true,
      requiresMfa: true,
      requiresVerifiedActor: false,
      requiresStateSnapshot: false,
      requiredAssertionClasses: ["regulatory", "identity", "approval"],
    },
    authorizationPattern: {
      type: "human-only",
      machineExecutable: false,
      rationale:
        "Compliance certification is a legal act performed by a qualified authority. No machine can certify; the permit proves a qualified human did.",
    },
    regulatoryFrameworks: ["eu_ai_act", "sox", "21cfr_part_11", "hipaa"],
  },
} as const satisfies Record<string, ActionCatalogEntry>;

// ── Derived types ────────────────────────────────────────────────────────────

export type ActionCatalogKey = keyof typeof ACTION_CATALOG;
export type ActionSlug = (typeof ACTION_CATALOG)[ActionCatalogKey]["slug"];
export type ActionId = (typeof ACTION_CATALOG)[ActionCatalogKey]["id"];

// ── Helper functions ─────────────────────────────────────────────────────────

/** Look up a catalog entry by its runtime slug. */
export function getActionBySlug(slug: string): ActionCatalogEntry | undefined {
  return Object.values(ACTION_CATALOG).find((a) => a.slug === slug);
}

/** Look up a catalog entry by its CAR identifier. */
export function getActionById(id: string): ActionCatalogEntry | undefined {
  return Object.values(ACTION_CATALOG).find((a) => a.id === id);
}

/** All catalog entries as an array. */
export function listActions(): ActionCatalogEntry[] {
  return Object.values(ACTION_CATALOG);
}

/** All action slugs — useful for type-safe evaluate request construction. */
export const ACTION_SLUGS = Object.values(ACTION_CATALOG).map(
  (a) => a.slug,
) as ActionSlug[];
