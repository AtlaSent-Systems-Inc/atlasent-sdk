/**
 * CI deploy-gate: evaluate, then verifyPermitById before deploying.
 *
 * Wires AtlaSent into a production deploy pipeline. The deploy is
 * blocked unless (a) the policy engine allows it AND (b) the
 * resulting permit verifies end-to-end.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... GIT_SHA=$(git rev-parse HEAD) \
 *     APPROVER=$USER npx tsx examples/deploy-gate.ts
 */

import { AtlaSentClient, AtlaSentError } from "@atlasent/sdk";

const apiKey = process.env.ATLASENT_API_KEY;
if (!apiKey) {
  console.error("ATLASENT_API_KEY env var is required");
  process.exit(2);
}

const client = new AtlaSentClient({ apiKey, timeoutMs: 5_000 });

const deployContext = {
  service: process.env.SERVICE ?? "billing-api",
  environment: process.env.TARGET_ENV ?? "production",
  commit: process.env.GIT_SHA ?? "unknown",
  approver: process.env.APPROVER ?? "unknown",
  ci: process.env.GITHUB_RUN_ID ?? process.env.BUILDKITE_BUILD_ID ?? "local",
};

async function main(): Promise<void> {
  let evaluation;
  try {
    evaluation = await client.evaluate({
      agent: "ci-deploy-bot",
      action: "deploy_to_production",
      context: deployContext,
    });
  } catch (err) {
    if (err instanceof AtlaSentError) {
      console.error(
        `AtlaSent unavailable (code=${err.code} status=${err.status ?? "?"}): ${err.message}`,
      );
      process.exit(3); // fail-closed: cannot confirm → do not deploy
    }
    throw err;
  }

  if (evaluation.decision !== "ALLOW") {
    console.error(`Deploy blocked: ${evaluation.reason}`);
    console.error(`  permitId:   ${evaluation.permitId}`);
    console.error(`  auditHash:  ${evaluation.auditHash}`);
    process.exit(1);
  }

  const verification = await client.verifyPermitById(evaluation.permitId);

  if (!verification.valid) {
    console.error(
      `Permit ${evaluation.permitId} failed verification: ${verification.reason ?? "unknown"}`,
    );
    process.exit(1);
  }

  console.log(
    `Deploy approved — permitId=${evaluation.permitId} payloadHash=${verification.evidence.payload_hash ?? "n/a"}`,
  );
  console.log(`  verifiedAt: ${verification.verified_at}`);
  console.log(`  auditHash:  ${evaluation.auditHash}`);
  // runDeploy();
}

void main();
