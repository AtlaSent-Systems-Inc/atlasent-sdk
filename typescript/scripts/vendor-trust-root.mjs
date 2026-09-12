#!/usr/bin/env node
// Re-vendor src/vendoredTrustRoot.generated.ts from the canonical public
// trust root published by atlasent-keys.
//
// Source of truth (in priority order):
//   1. atlasent-keys/.well-known/atlasent-trust-root.json      (issued_at / valid_until)
//      atlasent-keys/.well-known/atlasent-verifier-keys.json   (keys)
//      atlasent-keys/.well-known/atlasent-revocations.json     (revoked_keys / revoked_identities)
//   2. https://keys.atlasent.io/.well-known/<file> — same three files, live.
//
// This script only transcribes that JSON into a typed TS module — it never
// invents key material. Run it whenever atlasent-keys' trust root changes
// (a key rotation, a revocation) so the SDK's embedded baseline snapshot
// stays current; the SDK's background refresh (TrustRootManager) still
// keeps a long-running process fresh between vendoring passes.
//
// Why embedded, not read from disk at runtime (see trustRoot.ts's own
// header for the incident this closes): the previous design read
// vendor/trust-root/*.json via fs.readFileSync at first use. Those files
// were never included in the published npm package (package.json's
// `files` field never listed `vendor`), and the path-resolution math
// additionally broke under tsup's single-file bundle output — so every
// real install silently fell back to an empty, never-expiring snapshot
// (zero keys, zero revocations), and the static `node:fs`/`node:url`/
// `node:path` imports also broke bundling for any browser consumer.
// Embedding the data as a plain object literal at build time fixes both:
// no file I/O, no path guessing, and nothing Node-specific to bundle.
//
// Usage:
//   node scripts/vendor-trust-root.mjs [path/to/atlasent-keys/checkout]
// Default path assumes atlasent-keys is a sibling checkout
// (../../atlasent-keys relative to this script, i.e. a sibling of
// atlasent-sdk/). Falls back to a live fetch from keys.atlasent.io if the
// local checkout isn't found and no path was given.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(here, "..", "src", "vendoredTrustRoot.generated.ts");

const LIVE_BASE_URL = "https://keys.atlasent.io/.well-known";

async function loadThree(localDir) {
  if (localDir) {
    return {
      trustRoot: JSON.parse(readFileSync(resolve(localDir, "atlasent-trust-root.json"), "utf8")),
      verifierKeys: JSON.parse(readFileSync(resolve(localDir, "atlasent-verifier-keys.json"), "utf8")),
      revocations: JSON.parse(readFileSync(resolve(localDir, "atlasent-revocations.json"), "utf8")),
    };
  }
  const [trustRoot, verifierKeys, revocations] = await Promise.all(
    ["atlasent-trust-root.json", "atlasent-verifier-keys.json", "atlasent-revocations.json"].map(
      async (name) => {
        const res = await fetch(`${LIVE_BASE_URL}/${name}`);
        if (!res.ok) throw new Error(`fetch ${name}: ${res.status} ${res.statusText}`);
        return res.json();
      },
    ),
  );
  return { trustRoot, verifierKeys, revocations };
}

async function main() {
  const argPath = process.argv[2];
  const defaultLocalDir = resolve(here, "..", "..", "..", "atlasent-keys", ".well-known");
  const localDir = argPath
    ? resolve(process.cwd(), argPath)
    : existsSync(defaultLocalDir)
      ? defaultLocalDir
      : null;

  const { trustRoot, verifierKeys, revocations } = await loadThree(localDir);

  const snapshot = {
    valid_until: trustRoot.valid_until,
    issued_at: trustRoot.issued_at,
    keys: verifierKeys.keys ?? [],
    revoked_keys: revocations.revoked_keys ?? [],
    revoked_identities: revocations.revoked_identities ?? [],
  };

  const j = (v) => JSON.stringify(v, null, 2);

  const ts = `// GENERATED-DERIVED — do not edit directly.
// Source: atlasent-keys' .well-known/{atlasent-trust-root,atlasent-verifier-keys,
//   atlasent-revocations}.json — the canonical public trust root published at
//   https://keys.atlasent.io/.well-known/.
// Re-vendor: node scripts/vendor-trust-root.mjs [path/to/atlasent-keys/.well-known]
// Do NOT hand-edit — update atlasent-keys upstream and re-vendor.
//
// This is the SDK's embedded baseline trust-root snapshot (see trustRoot.ts).
// It is a plain object literal on purpose: no file I/O, no path resolution,
// nothing Node-specific, so it is safe to bundle for any target (Node,
// browser, edge). TrustRootManager's background refresh keeps a
// long-running process current between vendoring passes; this baseline is
// what every process has from the very first call, with no network
// round-trip and no reliance on files shipping alongside dist/.

import type { TrustRootSnapshot } from "./trustRoot.js";

export const VENDORED_TRUST_ROOT_SNAPSHOT: TrustRootSnapshot = ${j(snapshot)};
`;

  writeFileSync(OUT_PATH, ts);
  console.log(
    `vendored ${OUT_PATH} from ${localDir ?? LIVE_BASE_URL} — ` +
      `${snapshot.keys.length} key(s), ${snapshot.revoked_keys.length} revocation(s), ` +
      `valid_until ${snapshot.valid_until}`,
  );
}

main().catch((err) => {
  console.error(`[vendor-trust-root] error: ${err.message}`);
  process.exitCode = 1;
});
