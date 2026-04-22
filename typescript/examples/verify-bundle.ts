/**
 * Offline-verify a signed audit-export bundle.
 *
 * Run with:
 *   npx tsx examples/verify-bundle.ts \
 *     atlasent-audit-export.json [path/to/trusted-public-key.pem]
 *
 * The trust-anchor PEM is optional; omit it for a self-verify only
 * (the bundle verifies its own signature against the embedded key,
 * but can't tell you the signer is who you think it is).
 */

import { readFile } from "node:fs/promises";

import { verifyBundle } from "@atlasent/sdk";

const [, , exportPath, trustedKeyPath] = process.argv;
if (!exportPath) {
  console.error(
    "usage: npx tsx examples/verify-bundle.ts <export.json> [trust-anchor.pem]",
  );
  process.exit(2);
}

const result = trustedKeyPath
  ? await verifyBundle(exportPath, {
      trustedPublicKeyPem: await readFile(trustedKeyPath, "utf8"),
    })
  : await verifyBundle(exportPath);

console.log(`chainOk:      ${result.chainOk}`);
console.log(`signatureOk:  ${result.signatureOk}`);
if (result.trustedKeyOk !== null) {
  console.log(`trustedKey:   ${result.trustedKeyOk}`);
}
for (const err of result.errors) {
  console.error(`  - ${err}`);
}
console.log(result.ok ? "VERIFIED" : "FAILED");
process.exit(result.ok ? 0 : 1);
