"""AtlaSent SDK verticals — domain-specific ``protect()`` wrappers.

Each sub-module provides typed, fail-closed convenience wrappers for a
specific action cluster.  All wrappers ultimately call
:func:`atlasent.protect` and set the correct ``machine_executable``,
``risk_level``, and ``hitl_escalation`` context fields so the
server-side resolver can route appropriately.

Phase 4 clusters
----------------
- :mod:`atlasent.verticals.hr_actions` — HR offboarding, access revoke,
  role escalation.
- :mod:`atlasent.verticals.model_governance` — ML model promotion,
  retirement, fine-tuning.
- :mod:`atlasent.verticals.data_delete` — GDPR customer data deletion.
- :mod:`atlasent.verticals.contract_actions` — Contract execution and
  amendment.
- :mod:`atlasent.verticals.pricing_actions` — Pricing rule publishing
  and discount approval.

Phase 5 clusters
----------------
- :mod:`atlasent.verticals.security_actions` — Security incident
  escalation and access quarantine.
- :mod:`atlasent.verticals.access_cert` — Access certificate revocation.
- :mod:`atlasent.verticals.financial_close` — Financial period-close
  certification.

Phase 6 clusters
----------------
- :mod:`atlasent.verticals.database_actions` — Database migration apply,
  schema drop, and table delete with evidence callbacks.

Phase 7 clusters
----------------
- :mod:`atlasent.verticals.deploy_gate` — Production deployment
  authorization with HITL escalation and optional Slack notification.
"""

from .deploy_gate import (
    protect_deploy,
    protect_production_deploy,
)
from .access_cert import (
    AccessCertActionType,
    protect_access_cert_action,
    protect_access_cert_revoke,
)
from .contract_actions import (
    ContractActionType,
    protect_contract_action,
    protect_contract_execution,
)
from .data_delete import (
    DataDeleteActionType,
    GdprLegalBasis,
    protect_customer_data_delete,
)
from .database_actions import (
    DatabaseActionType,
    DatabaseDestructiveActionType,
    DatabaseMigrationActionType,
    DenialEvidence,
    PermitEvidence,
    protect_database_action,
    protect_database_migration,
    protect_database_schema_drop,
    protect_database_table_delete,
)
from .financial_close import (
    FinancialCloseActionType,
    protect_financial_close_action,
    protect_period_close_certify,
)
from .hr_actions import (
    HrActionType,
    protect_hr_action,
    protect_hr_offboard,
    protect_hr_role_escalate,
)
from .model_governance import (
    ModelGovernanceActionType,
    protect_model_governance,
    protect_model_promotion,
)
from .pricing_actions import (
    PricingActionType,
    protect_pricing_action,
    protect_pricing_rule,
)
from .security_actions import (
    SecurityActionType,
    SecurityIncidentSeverity,
    protect_security_access_quarantine,
    protect_security_action,
    protect_security_incident_escalate,
)

__all__ = [
    # Deploy gate
    "protect_deploy",
    "protect_production_deploy",
    # HR actions
    "HrActionType",
    "protect_hr_action",
    "protect_hr_offboard",
    "protect_hr_role_escalate",
    # Model governance
    "ModelGovernanceActionType",
    "protect_model_governance",
    "protect_model_promotion",
    # Data deletion
    "DataDeleteActionType",
    "GdprLegalBasis",
    "protect_customer_data_delete",
    # Contract actions
    "ContractActionType",
    "protect_contract_action",
    "protect_contract_execution",
    # Pricing actions
    "PricingActionType",
    "protect_pricing_action",
    "protect_pricing_rule",
    # Security actions
    "SecurityActionType",
    "SecurityIncidentSeverity",
    "protect_security_action",
    "protect_security_incident_escalate",
    "protect_security_access_quarantine",
    # Access cert
    "AccessCertActionType",
    "protect_access_cert_action",
    "protect_access_cert_revoke",
    # Financial close
    "FinancialCloseActionType",
    "protect_financial_close_action",
    "protect_period_close_certify",
    # Database actions
    "DatabaseActionType",
    "DatabaseDestructiveActionType",
    "DatabaseMigrationActionType",
    "DenialEvidence",
    "PermitEvidence",
    "protect_database_action",
    "protect_database_migration",
    "protect_database_schema_drop",
    "protect_database_table_delete",
]
