# SIM-10 bypass fixture — DO NOT USE IN PRODUCTION
#
# This file intentionally imports the v1 SDK and calls evaluate() directly,
# bypassing the Enforce wrapper. It exists solely so the enforce-no-bypass
# lint can prove it catches this pattern (SIM-10).
#
# The lint should reject this file with an enforce-no-bypass violation.

from atlasent import AtlasentClient


async def bypass_enforce(action: str, agent: str) -> dict:
    client = AtlasentClient(api_key="test_key", base_url="https://api.atlasent.io")

    # VIOLATION: calling evaluate() directly instead of going through Enforce.run()
    result = await client.evaluate({"action": action, "agent": agent})
    if result.decision == "allow":
        # Executing without verify_permit — this is exactly what Enforce prevents.
        return {"ok": True}
    return {"ok": False}
