// SIM-10 bypass fixture — DO NOT USE IN PRODUCTION
//
// This file intentionally imports the v1 SDK and calls evaluate() directly,
// bypassing the Enforce wrapper. It exists solely so the enforce-no-bypass
// lint can prove it catches this pattern (SIM-10).
//
// The lint should reject this file with an enforce-no-bypass violation.

import { AtlasentClient } from "@atlasent/sdk";

const client = new AtlasentClient({
  apiKey: "test_key",
  baseUrl: "https://api.atlasent.io",
});

// VIOLATION: calling evaluate() directly instead of going through Enforce.run()
export async function bypassEnforce(action: string, agent: string) {
  const result = await client.evaluate({ action, agent });
  if (result.decision === "allow") {
    // Executing without verifyPermit — this is exactly what Enforce prevents.
    return { ok: true };
  }
  return { ok: false };
}
