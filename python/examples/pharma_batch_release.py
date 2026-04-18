"""
Example: Pharmaceutical Batch Release Authorization
Authorize EU batch release with QP certification using the AtlaSent SDK.
"""
import os
from atlasent import PermissionDeniedError, authorize, configure

configure(api_key=os.environ.get("ATLASENT_API_KEY"))

try:
    result = authorize(
        agent="batch-release-agent-v1",
        action={
            "type": "pharma.batch.release",
            "resource": "batch/BN-2026-0042",
        },
        context={
            "batch_number": "BN-2026-0042",
            "product_code": "PROD-EU-TABLET-10MG",
            "market": "EU",
            "qp_certified": True,
            "qc_release_complete": True,
            "open_oos_count": 0,
            "open_oot_count": 0,
            "capa_status": "none_required",
            "cold_chain_intact": True,
            "market_authorization_current": True,
            "approvals": ["qp", "qa_director"],
        },
        raise_on_deny=True,
    )
    print(f"Batch release authorized. Permit: {result.permit_id}")
    # Store permit ID in batch record for EU GMP Annex 11 audit trail

except PermissionDeniedError as e:
    print(f"Batch release denied: {e}")
    raise
