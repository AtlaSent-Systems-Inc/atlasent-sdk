/**
 * atlasent-verify — offline audit-bundle verifier CLI.
 *
 * Usage:
 *   atlasent-verify <bundle.json> [--key <pem-file>] [--key-env <VAR>] [--json] [--quiet]
 *
 * Options:
 *   --key <file>      SPKI-PEM public key file (repeatable)
 *   --key-env <VAR>   Read SPKI-PEM from environment variable (repeatable)
 *   --json            Output machine-readable JSON to stdout
 *   --quiet           Suppress all output; rely on exit code only
 *
 * Exit codes:
 *   0  verified (chain integrity OK and signature valid)
 *   1  not verified (chain tampered or signature invalid)
 *   2  usage or I/O error
 */

import { readFile } from "node:fs/promises";
import { verifyBundle } from "./index.js";

// ─── Argument parsing ─────────────────────────────────────────────────────────

interface CliArgs {
  bundlePath: string;
  keyFiles: string[];
  keyEnvVars: string[];
  json: boolean;
  quiet: boolean;
}

function parseArgs(argv: string[]): CliArgs | string {
  const args = argv.slice(2);
  const keyFiles: string[] = [];
  const keyEnvVars: string[] = [];
  let json = false;
  let quiet = false;
  let bundlePath = "";

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--key") {
      const v = args[++i];
      if (!v) return "--key requires a file argument";
      keyFiles.push(v);
    } else if (a === "--key-env") {
      const v = args[++i];
      if (!v) return "--key-env requires an environment variable name";
      keyEnvVars.push(v);
    } else if (a === "--json") {
      json = true;
    } else if (a === "--quiet") {
      quiet = true;
    } else if (a === "--help" || a === "-h") {
      return "help";
    } else if (a.startsWith("-")) {
      return `unknown option: ${a}`;
    } else {
      if (bundlePath) return "unexpected extra argument: " + a;
      bundlePath = a;
    }
  }

  if (!bundlePath) return "bundle path is required";
  return { bundlePath, keyFiles, keyEnvVars, json, quiet };
}

// ─── Key loading ──────────────────────────────────────────────────────────────

async function loadPems(keyFiles: string[], keyEnvVars: string[]): Promise<string[]> {
  const pems: string[] = [];
  for (const f of keyFiles) {
    pems.push(await readFile(f, "utf8"));
  }
  for (const name of keyEnvVars) {
    const val = process.env[name];
    if (val) pems.push(val);
  }
  return pems;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatHuman(
  bundlePath: string,
  result: Awaited<ReturnType<typeof verifyBundle>>,
): string {
  const lines: string[] = [];
  lines.push(`bundle:    ${bundlePath}`);
  lines.push(`verified:  ${result.verified ? "YES ✓" : "NO ✗"}`);
  lines.push(`chain:     ${result.chainIntegrityOk ? "ok" : "FAIL"}`);
  lines.push(`signature: ${result.signatureValid ? "ok" : "FAIL"}`);
  if (result.matchedKeyId) lines.push(`key-id:    ${result.matchedKeyId}`);
  if (result.tamperedEventIds.length > 0) {
    lines.push(`tampered:  ${result.tamperedEventIds.join(", ")}`);
  }
  if (result.reason) lines.push(`reason:    ${result.reason}`);
  return lines.join("\n");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const USAGE = `\
Usage: atlasent-verify <bundle.json> [--key <pem-file>] [--key-env <VAR>] [--json] [--quiet]

  --key <file>     SPKI-PEM public key file (repeatable)
  --key-env <VAR>  Read SPKI-PEM from environment variable (repeatable)
  --json           Output machine-readable JSON
  --quiet          No output; rely on exit code only

Exit codes: 0 verified  1 not verified  2 error`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);

  if (parsed === "help") {
    process.stdout.write(USAGE + "\n");
    process.exit(0);
  }

  if (typeof parsed === "string") {
    process.stderr.write(`atlasent-verify: ${parsed}\n\n${USAGE}\n`);
    process.exit(2);
  }

  const { bundlePath, keyFiles, keyEnvVars, json, quiet } = parsed;

  let pems: string[];
  try {
    pems = await loadPems(keyFiles, keyEnvVars);
  } catch (err) {
    process.stderr.write(`atlasent-verify: failed to read key file: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let result: Awaited<ReturnType<typeof verifyBundle>>;
  try {
    result = await verifyBundle(bundlePath, { publicKeysPem: pems });
  } catch (err) {
    process.stderr.write(`atlasent-verify: ${(err as Error).message}\n`);
    process.exit(2);
  }

  if (!quiet) {
    if (json) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    } else {
      process.stdout.write(formatHuman(bundlePath, result) + "\n");
    }
  }

  process.exit(result.verified ? 0 : 1);
}

main().catch((err: unknown) => {
  process.stderr.write(`atlasent-verify: unexpected error: ${(err as Error).message}\n`);
  process.exit(2);
});
