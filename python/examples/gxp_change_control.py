"""
Example: GxP Change Control Authorization
Authorize a change to a regulated computerized system using the AtlaSent SDK.
"""
import os
from atlasent import PermissionDeniedError, authorize, configure

configure(api_key=os.environ.get("ATLASENT_API_KEY"))

try:
    # Scenario: Major GAMP Cat 5 software update requiring QRB approval
    result = authorize(
        agent="change-control-agent-v1",
        action={
            "type": "gxp.change_control.apply",
            "resource": "system/LIMS-v3",
        },
        context={
            "system_name": "LIMS-v3",
            "gamp_category": 5,
            "change_type": "software_update",
            "risk_level": "major",
            "qrb_status": "approved",
            "validation_impact": "revalidation_required",
            "cfr_part_11_applicable": True,
            "in_production_window": False,
            "rollback_plan_verified": True,
            "approvals": ["qa_head", "it_delegate", "site_qp"],
        },
        raise_on_deny=True,
    )
    print(f"Change authorized. Permit: {result.permit_id}")
    # Store permit ID in change record for 21 CFR Part 11 audit trail

except PermissionDeniedError as e:
    print(f"Change denied: {e}")
    raise
