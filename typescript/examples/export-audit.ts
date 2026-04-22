/**
 * Export a signed, offline-verifiable audit bundle to disk.
 *
 * Requires an API key with the `audit` scope.
 *
 * Run with:
 *   ATLASENT_API_KEY=ask_live_... npx tsx examples/export-audit.ts
 */

import { writeFile } from "node:fs/promises";

import { AtlaSentClient } from "@atlasent/sdk";

const apiKey = process.env.ATLASENT_API_KEY;
if (!apiKey) {
  console.error("ATLASENT_API_KEY env var is required");
  process.exit(1);
}

const client = new AtlaSentClient({ apiKey });

const bundle = await client.exportAudit({
  since: "2026-01-01T00:00:00Z",
  limit: 5000,
});

const outPath = "atlasent-audit-export.json";
await writeFile(outPath, JSON.stringify(bundle.raw, null, 2), "utf8");

const adminCount = bundle.adminLog?.length ?? 0;
console.log(
  `wrote ${bundle.evaluations.length} evaluations + ${adminCount} admin rows to ${outPath}`,
);
console.log(`signature: ${bundle.signature.slice(0, 32)}…`);
