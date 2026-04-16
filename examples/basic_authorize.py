"""Basic authorization example.

Before running, set your API key:
    export ATLASENT_API_KEY=ask_live_...
"""

import atlasent

# Option 1: Configure explicitly
atlasent.configure(api_key="ask_live_your_key_here")

# Option 2: Let the SDK read ATLASENT_API_KEY from the environment
# (no configure() call needed)

# Evaluate an action
result = atlasent.authorize(
    agent="my-agent",
    action="read_patient_record",
    context={"patient_id": "PT-2024-001"},
)

# AuthorizationResult is truthy when permitted
if result:
    print(f"Permitted  — decision {result.decision_id}")
    print(f"  reason:     {result.reason}")
    print(f"  audit_hash: {result.audit_hash}")
else:
    print(f"Denied — {result.reason}")
