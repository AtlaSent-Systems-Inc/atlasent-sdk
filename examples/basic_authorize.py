"""Basic authorization example.

Before running, set your API key:
    export ATLASENT_API_KEY=ask_live_...
"""

from atlasent import AtlaSentClient, AtlaSentDenied

client = AtlaSentClient(api_key="ask_live_your_key_here")

try:
    # gate() calls evaluate() then verify() in one shot
    result = client.gate(
        action_type="read_patient_record",
        actor_id="my-agent",
        context={"patient_id": "PT-2024-001"},
    )
    print(f"Permitted — permit_token: {result.evaluation.permit_token}")
    print(f"  verified: {result.verification.valid}")
    print(f"  permit_hash: {result.verification.permit_hash}")
except AtlaSentDenied as e:
    print(f"Denied — {e.reason}")
    print(f"  decision: {e.decision}")
