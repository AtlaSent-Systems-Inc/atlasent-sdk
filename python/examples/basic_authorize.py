"""Basic authorization example — the one-call public API.

Before running, set your API key::

    export ATLASENT_API_KEY=ask_live_...
"""

from atlasent import authorize

result = authorize(
    agent="my-agent",
    action="read_patient_record",
    context={"patient_id": "PT-2024-001"},
)

if result.permitted:
    # → execute the action; the permit is on file
    print(f"Permitted: {result.reason}")
    print(f"  permit_token: {result.permit_token}")
    print(f"  permit_hash:  {result.permit_hash}")
    print(f"  verified:     {result.verified}")
else:
    print(f"Denied: {result.reason}")
    print(f"  permit_token: {result.permit_token}")
