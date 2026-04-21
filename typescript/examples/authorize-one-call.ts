/**
 * One-call authorization: `authorize()` returns a result — branch on
 * `permitted`, don't catch exceptions for the happy path.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... npx tsx examples/authorize-one-call.ts
 */

import { AtlaSentClient } from "@atlasent/sdk";

const apiKey = process.env.ATLASENT_API_KEY;
if (!apiKey) {
  console.error("ATLASENT_API_KEY env var is required");
  process.exit(1);
}

const client = new AtlaSentClient({ apiKey });

const result = await client.authorize({
  agent: "clinical-data-agent",
  action: "modify_patient_record",
  context: { user: "dr_smith", patientId: "PT-2024-001" },
});

if (!result.permitted) {
  console.error(`Denied: ${result.reason}`);
  process.exit(1);
}

// A verified permit is in hand — safe to act.
console.log(`ALLOW permitId=${result.permitId} permitHash=${result.permitHash}`);
// applyPatientRecordChange(...);
