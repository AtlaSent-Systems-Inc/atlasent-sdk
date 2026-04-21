/**
 * Using `gate()` with a TTLCache to deduplicate repeated decisions.
 *
 * `gate()` evaluates AND verifies in one call and throws
 * `PermissionDeniedError` on deny — so on a successful return, a
 * verified permit is in hand. The cache short-circuits repeated
 * evaluate calls for the same (agent, action, context) within its
 * TTL window.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... npx tsx examples/gate-with-cache.ts
 */

import {
  AtlaSentClient,
  PermissionDeniedError,
  TTLCache,
  consoleLogger,
} from "@atlasent/sdk";

const apiKey = process.env.ATLASENT_API_KEY;
if (!apiKey) {
  console.error("ATLASENT_API_KEY env var is required");
  process.exit(1);
}

const client = new AtlaSentClient({
  apiKey,
  cache: new TTLCache({ ttlMs: 30_000 }),
  logger: consoleLogger,
});

async function readPatientRecord(agentId: string, patientId: string): Promise<void> {
  try {
    const { verification } = await client.gate({
      agent: agentId,
      action: "read_patient_record",
      context: { patientId },
    });
    console.log(
      `reading patient ${patientId}, permitHash=${verification.permitHash}`,
    );
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      console.error(`blocked for ${agentId} → ${patientId}: ${err.reason}`);
      return;
    }
    throw err;
  }
}

// Two calls within the cache TTL — the second hits the cache for
// evaluate, then re-verifies against the server.
await readPatientRecord("clinical-data-agent", "PT-2024-001");
await readPatientRecord("clinical-data-agent", "PT-2024-001");
