/**
 * Basic example: evaluate an agent action and log the decision.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... npx tsx examples/basic.ts
 */

import { AtlaSentClient } from "@atlasent/sdk";

const apiKey = process.env.ATLASENT_API_KEY;
if (!apiKey) {
  console.error("ATLASENT_API_KEY env var is required");
  process.exit(1);
}

const client = new AtlaSentClient({ apiKey });

const result = await client.evaluate({
  agent: "clinical-data-agent",
  action: "modify_patient_record",
  context: {
    user: "dr_smith",
    environment: "production",
    patientId: "PT-2024-001",
  },
});

if (result.decision === "ALLOW") {
  console.log(`ALLOW permitId=${result.permitId} auditHash=${result.auditHash}`);
  // execute the action here
} else {
  console.log(`DENY reason="${result.reason}" permitId=${result.permitId}`);
}
