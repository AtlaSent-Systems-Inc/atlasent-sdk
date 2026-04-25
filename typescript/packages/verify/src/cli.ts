/**
 * `atlasent-verify` — auditor-facing CLI.
 *
 * ```sh
 * npx @atlasent/verify ./bundle.json
 * # or, with a trust-set PEM file:
 * npx @atlasent/verify ./bundle.json --pem ./signing-key.pub.pem
 * ```
 *
 * Exits 0 when the bundle verifies (chain-integrity AND signature),
 * 1 otherwise. Prints a single human-readable line to stdout plus,
 * on failure, a structured reason to stderr.
 *
 * Intentionally minimal: no flag parser, no colors, no spinner. The
 * audience is a compliance reviewer reading the output once during
 * an audit, not an SRE looking at log volume.
 */
import { readFile } from "node:fs/promises";

import { verifyBundle } from "./verify.js";

const USAGE = `Usage: atlasent-verify <bundle.json> [--pem <signing-key.pub.pem>]

  bundle.json   Path to a signed audit-export bundle (JSON).
  --pem PATH    Optional. SPKI-PEM public key file. Repeatable.

Exit code:
  0  bundle verified (chain integrity AND signature)
  1  any check failed, file missing, or bad arguments`;

interface ParsedArgs {
  bundlePath: string;
  pemPaths: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs | null {
  const args = argv.slice(2);
  if (args.length === 0) return null;
  const pemPaths: string[] = [];
  let bundlePath: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--pem") {
      const next = args[i + 1];
      if (!next) return null;
      pemPaths.push(next);
      i++;
      continue;
    }
    if (a === "-h" || a === "--help") return null;
    if (typeof a === "string" && !a.startsWith("-")) {
      if (bundlePath) return null; // second positional → ambiguous
      bundlePath = a;
    } else {
      return null;
    }
  }
  if (!bundlePath) return null;
  return { bundlePath, pemPaths };
}

export async function run(
  argv: readonly string[],
  out: (msg: string) => void,
  err: (msg: string) => void,
): Promise<number> {
  const parsed = parseArgs(argv);
  if (!parsed) {
    err(USAGE);
    return 1;
  }

  const publicKeysPem: string[] = [];
  for (const p of parsed.pemPaths) {
    try {
      publicKeysPem.push(await readFile(p, "utf8"));
    } catch (e) {
      err(`failed to read PEM file ${p}: ${(e as Error).message}`);
      return 1;
    }
  }

  let result: Awaited<ReturnType<typeof verifyBundle>>;
  try {
    result = await verifyBundle(
      parsed.bundlePath,
      publicKeysPem.length > 0 ? { publicKeysPem } : undefined,
    );
  } catch (e) {
    err(`failed to verify ${parsed.bundlePath}: ${(e as Error).message}`);
    return 1;
  }

  if (result.verified) {
    out("verified: true");
    return 0;
  }
  out(`verified: false`);
  if (result.reason) err(`reason: ${result.reason}`);
  if (result.tamperedEventIds.length > 0) {
    err(`tampered_event_ids: ${result.tamperedEventIds.join(",")}`);
  }
  return 1;
}

// Only execute when invoked as a script (skipped under vitest's
// dynamic import). The block below runs only in the bin script after
// tsup has built `dist/cli.js`; the smoke step in CI exercises it
// end-to-end. Excluded from coverage because the test boundary is
// process spawn, not in-process.
/* v8 ignore start */
const invokedAsScript =
  typeof process !== "undefined" &&
  Array.isArray(process.argv) &&
  process.argv[1] !== undefined &&
  /cli\.(js|cjs|mjs|ts)$/.test(process.argv[1]);

if (invokedAsScript) {
  run(process.argv, (m) => console.log(m), (m) => console.error(m)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(`atlasent-verify crashed: ${(e as Error).message}`);
      process.exit(1);
    },
  );
}
/* v8 ignore stop */
