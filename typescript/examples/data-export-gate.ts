/**
 * Data-export gate: evaluate, then verifyPermit before emitting a
 * patient-data export. Captures the auditHash and permit in the
 * export manifest so regulators can tie every exported row back to
 * a policy decision.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... REQUESTER=$USER \
 *     DATASET=trial_ABC-2026-phase2 \
 *     npx tsx examples/data-export-gate.ts
 */

import { AtlaSentClient, AtlaSentError } from "@atlasent/sdk";

const apiKey = process.env.ATLASENT_API_KEY;
if (!apiKey) {
  console.error("ATLASENT_API_KEY env var is required");
  process.exit(2);
}

const client = new AtlaSentClient({ apiKey, timeoutMs: 5_000 });

const exportContext = {
  dataset: process.env.DATASET ?? "trial_unspecified",
  requester: process.env.REQUESTER ?? "unknown",
  destination: process.env.DESTINATION ?? "s3://atlasent-exports/outbound/",
  classification: process.env.CLASSIFICATION ?? "PHI",
  purpose: process.env.PURPOSE ?? "regulatory_submission",
};

interface ExportManifest {
  dataset: string;
  requester: string;
  permitId: string;
  permitHash: string;
  auditHash: string;
  approvedAt: string;
}

async function main(): Promise<void> {
  let evaluation;
  try {
    evaluation = await client.evaluate({
      agent: "data-export-agent",
      action: "export_patient_dataset",
      context: exportContext,
    });
  } catch (err) {
    if (err instanceof AtlaSentError) {
      console.error(
        `AtlaSent unavailable (code=${err.code} status=${err.status ?? "?"} requestId=${err.requestId ?? "?"}): ${err.message}`,
      );
      // fail-closed: cannot confirm authorization → do not export
      process.exit(3);
    }
    throw err;
  }

  if (evaluation.decision !== "ALLOW") {
    console.error(`Export blocked: ${evaluation.reason}`);
    console.error(`  permitId:  ${evaluation.permitId}`);
    console.error(`  auditHash: ${evaluation.auditHash}`);
    process.exit(1);
  }

  const verification = await client.verifyPermit({
    permitId: evaluation.permitId,
    agent: "data-export-agent",
    action: "export_patient_dataset",
    context: exportContext,
  });

  if (!verification.verified) {
    console.error(`Permit ${evaluation.permitId} failed verification`);
    process.exit(1);
  }

  const manifest: ExportManifest = {
    dataset: exportContext.dataset,
    requester: exportContext.requester,
    permitId: evaluation.permitId,
    permitHash: verification.permitHash,
    auditHash: evaluation.auditHash,
    approvedAt: evaluation.timestamp,
  };

  console.log(JSON.stringify(manifest, null, 2));
  // writeManifest(manifest); streamExport(exportContext);
}

void main();
