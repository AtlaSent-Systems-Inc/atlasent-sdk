#!/usr/bin/env node
// Usage: ATLASENT_API_KEY=ask_live_xxx npx ts-node quickstart/index.ts

import { AtlaSentClient } from "../src/index.js";

async function main() {
  const apiKey = process.env.ATLASENT_API_KEY;
  const baseUrl = process.env.ATLASENT_BASE_URL ?? "https://api.atlasent.io";

  if (!apiKey) {
    console.error("✗ ATLASENT_API_KEY is required");
    process.exit(1);
  }

  const client = new AtlaSentClient({ apiKey, baseUrl });

  console.log("\n AtlaSent Pilot Quickstart\n");
  console.log(`  API: ${baseUrl}`);
  console.log(`  Key: ${apiKey.slice(0, 12)}...\n`);

  // Step 1: Test connectivity
  // keySelf is a lightweight GET that validates the API key without
  // touching policy state — ideal as a connectivity probe.
  await step("Step 1/4  Verify connectivity", async () => {
    await client.keySelf();
  });

  // Step 2: First evaluation
  let decision: string | undefined;
  let permitToken: string | null = null;
  let evaluationId: string | undefined;
  await step("Step 2/4  Run first evaluate call", async () => {
    const t0 = Date.now();
    const result = await client.evaluate({
      action_type: "ai.code.review",
      actor_id: "quickstart-pilot-user",
      context: {
        environment: "staging",
        source: "atlasent-quickstart",
      },
    });
    const ms = Date.now() - t0;
    decision = result.decision;
    permitToken = result.permitToken;
    evaluationId = result.evaluationId;
    console.log(
      `       decision=${result.decision}  latency=${ms}ms  evaluation_id=${result.evaluationId}`,
    );
  });

  // Step 3: Verify permit (if allowed)
  if (permitToken) {
    await step("Step 3/4  Verify permit token", async () => {
      const v = await client.verifyPermit({
        permitId: permitToken as string,
        action: "ai.code.review",
        agent: "quickstart-pilot-user",
      });
      console.log(`       verified=${v.verified}  outcome=${v.outcome}`);
    });
  } else {
    console.log(
      "  ~  Step 3/4  Permit verification skipped (decision was not allow)",
    );
  }

  // Step 4: Summary
  console.log("\n  Quickstart complete!\n");
  console.log(`  Decision:      ${decision}`);
  if (evaluationId) console.log(`  Evaluation ID: ${evaluationId}`);
  if (permitToken) {
    console.log(`  Permit:        ${permitToken.slice(0, 20)}...`);
    console.log(
      `\n  Audit proof: GET ${baseUrl}/v1/decisions/${evaluationId}`,
    );
    console.log(
      `  Verify:      atlasent verify-permit ${permitToken.slice(0, 20)}...`,
    );
  }
  console.log(`\n  Next steps:`);
  console.log(
    `    1. Add action classes for your real workload via POST /v1/action-classes`,
  );
  console.log(
    `    2. Publish a policy bundle via POST /v1/policy-bundles`,
  );
  console.log(
    `    3. Integrate client.evaluate() in your application`,
  );
  console.log(
    `    4. Monitor activity at ${baseUrl.replace("api.", "app.")}\n`,
  );
}

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`  ⋯  ${label}...`);
  try {
    await fn();
    process.stdout.write(`\r  ✓  ${label}\n`);
  } catch (err: unknown) {
    process.stdout.write(`\r  ✗  ${label}\n`);
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`       Error: ${msg}`);
    // Non-fatal — continue
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
