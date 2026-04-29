/**
 * `atlasent-v2-verify` — offline proof-bundle verifier as a CLI.
 *
 * Wraps {@link replayProofBundle} in a runnable shell entry point
 * so auditors / CI jobs can verify a signed bundle without writing
 * any TS or Python.
 *
 * Usage:
 *
 *   atlasent-v2-verify [--strict] [--json|--text] --key <pem>... <bundle.json>
 *
 * Exit codes:
 *   0 — every proof verified
 *   1 — at least one proof failed (or incomplete in --strict mode)
 *   2 — usage / file-load / parse error
 *
 * Output formats:
 *   --json (default)  Single JSON object: { passed, failed, incomplete,
 *                     proofs: [{ proof_id, verification_status, checks }, ...] }
 *   --text            Human-readable summary, one line per proof.
 *
 * Multiple `--key` arguments are accepted and tried in order
 * (rotation-aware via the `signing_key_id` hint on each proof —
 * see {@link replayProofBundle} for the per-key precedence rules).
 */

import { readFile } from "node:fs/promises";
import { createPublicKey, webcrypto } from "node:crypto";

import { replayProofBundle, type VerifyKey } from "../verifyProof.js";
import type { Proof } from "../types.js";

/** Result of {@link parseArgs} when args are valid. */
export interface ParsedArgs {
  bundlePath: string;
  keyPaths: string[];
  strict: boolean;
  format: "json" | "text";
}

/** Thrown by {@link parseArgs} on bad CLI input — wraps a usage error. */
export class CliUsageError extends Error {
  readonly name = "CliUsageError";
}

/**
 * Parse argv into a {@link ParsedArgs}. Throws {@link CliUsageError}
 * with a human-readable message on bad input. Caller should print
 * that message + usage to stderr and exit 2.
 *
 * Doesn't read any files — pure argument shape validation.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const keyPaths: string[] = [];
  let bundlePath: string | undefined;
  let strict = false;
  let format: "json" | "text" = "json";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--strict":
        strict = true;
        break;
      case "--json":
        format = "json";
        break;
      case "--text":
        format = "text";
        break;
      case "--key": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) {
          throw new CliUsageError("--key requires a path argument");
        }
        keyPaths.push(next);
        i += 1;
        break;
      }
      case "-h":
      case "--help":
        throw new CliUsageError("__help__");
      default:
        if (arg.startsWith("--")) {
          throw new CliUsageError(`unknown option: ${arg}`);
        }
        if (bundlePath !== undefined) {
          throw new CliUsageError(
            `unexpected positional arg: ${arg} (already have bundle path)`,
          );
        }
        bundlePath = arg;
    }
  }

  if (bundlePath === undefined) {
    throw new CliUsageError("missing required <bundle.json> path");
  }

  return { bundlePath, keyPaths, strict, format };
}

/**
 * Parse a `--key` argument into `(keyId, path)`.
 *
 * Two forms accepted:
 *   * `path/to/key.pem` — keyId derived from the basename
 *     (`key.pub.pem` → `key`).
 *   * `<id>=<path>` — keyId given explicitly. Use when the
 *     `signing_key_id` on the proofs doesn't match the file
 *     basename (typical for shared / public-name fixtures).
 *
 * Exported for tests; not part of the runtime API.
 */
export function parseKeySpec(spec: string): { keyId: string; path: string } {
  // A '=' anywhere triggers the explicit-id form. Falls through to
  // basename derivation only when no '=' is present at all.
  const eq = spec.indexOf("=");
  if (eq !== -1) {
    const keyId = spec.slice(0, eq);
    const path = spec.slice(eq + 1);
    if (!keyId || !path) {
      throw new CliUsageError(
        `--key value must be either <path> or <id>=<path>: ${spec}`,
      );
    }
    return { keyId, path };
  }
  const base = spec.split(/[\\/]/).pop() ?? spec;
  const keyId = base.replace(/\.pub\.pem$/, "").replace(/\.pem$/, "");
  return { keyId, path: spec };
}

/**
 * Load an SPKI-PEM Ed25519 public key from disk and import it as a
 * webcrypto `CryptoKey`. The `--key` argument's `id=path` syntax is
 * parsed by {@link parseKeySpec}; this fn just loads the bytes and
 * imports them.
 */
export async function loadVerifyKey(spec: string): Promise<VerifyKey> {
  const { keyId, path } = parseKeySpec(spec);
  const pem = await readFile(path, "utf8");
  const spki = createPublicKey(pem).export({ format: "der", type: "spki" });
  const cryptoKey = await webcrypto.subtle.importKey(
    "spki",
    spki,
    { name: "Ed25519" },
    true,
    ["verify"],
  );
  return { keyId, publicKey: cryptoKey };
}

/**
 * Load + parse a JSON file containing either:
 *   - a wrapper `{ "proofs": Proof[] }` (the shared fixture format)
 *   - a bare `Proof[]` array
 *   - a single `Proof` object
 *
 * Returns the proof list. Throws on unparseable JSON or unrecognized
 * top-level shape.
 */
export async function loadBundle(path: string): Promise<Proof[]> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `failed to parse ${path} as JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (Array.isArray(parsed)) {
    return parsed as Proof[];
  }
  if (parsed && typeof parsed === "object" && "proofs" in parsed) {
    const proofs = (parsed as { proofs: unknown }).proofs;
    if (!Array.isArray(proofs)) {
      throw new Error(`${path}: \`proofs\` must be an array`);
    }
    return proofs as Proof[];
  }
  if (parsed && typeof parsed === "object" && "proof_id" in parsed) {
    return [parsed as Proof];
  }
  throw new Error(
    `${path}: expected a Proof, an array of Proofs, or a {proofs:[...]} wrapper`,
  );
}

/** The whole CLI: parse args, load files, run replay, format output. */
export interface RunResult {
  /** What the CLI would have printed to stdout. */
  stdout: string;
  /** Process exit code. 0 = success, 1 = verification failed, 2 = usage. */
  exitCode: 0 | 1 | 2;
  /** Optional message for stderr — usage errors, file-load errors. */
  stderr?: string;
}

const USAGE = `Usage: atlasent-v2-verify [options] <bundle.json>

Options:
  --key <spec>   SPKI-PEM Ed25519 public key (repeatable). <spec> is
                 either:
                   <path>            — keyId from basename
                                       (key.pub.pem → "key")
                   <id>=<path>       — keyId given explicitly. Use
                                       when proof signing_key_id
                                       doesn't match the basename.
  --strict       Treat \`pending\` proofs as failures.
  --json         JSON output (default).
  --text         Human-readable output, one line per proof.
  -h, --help     Show this help.

Exit codes:
  0  every proof verified
  1  at least one proof failed (or incomplete in --strict mode)
  2  usage / file-load / parse error

Examples:
  atlasent-v2-verify --key audit-export-pub.pem bundle.json
  atlasent-v2-verify --strict --text --key v2-proof-key-active=k1.pem bundle.json`;

/**
 * Programmatic CLI entry. Tests call this directly; the bin shim
 * (`bin/atlasent-v2-verify.mjs`) calls it with `process.argv.slice(2)`
 * and forwards stdout / stderr / exit code to the real process.
 */
export async function run(argv: readonly string[]): Promise<RunResult> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    if (err instanceof CliUsageError && err.message === "__help__") {
      return { stdout: USAGE + "\n", exitCode: 0 };
    }
    const msg = err instanceof Error ? err.message : String(err);
    return { stdout: "", stderr: `${msg}\n${USAGE}\n`, exitCode: 2 };
  }

  let proofs: Proof[];
  try {
    proofs = await loadBundle(parsed.bundlePath);
  } catch (err) {
    return {
      stdout: "",
      stderr: `${err instanceof Error ? err.message : String(err)}\n`,
      exitCode: 2,
    };
  }

  let keys: VerifyKey[];
  try {
    keys = await Promise.all(parsed.keyPaths.map(loadVerifyKey));
  } catch (err) {
    return {
      stdout: "",
      stderr: `failed to load key file: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
      exitCode: 2,
    };
  }

  const result = await replayProofBundle(proofs, {
    keys,
    strict: parsed.strict,
  });

  // Exit code: 0 if everything passed; 1 if any failed, OR any
  // incomplete + --strict (which already converts incomplete to
  // failed, but be explicit for clarity).
  const failedAny = result.failed > 0;
  const exitCode: 0 | 1 = failedAny ? 1 : 0;

  let stdout: string;
  if (parsed.format === "json") {
    stdout = JSON.stringify(result, null, 2) + "\n";
  } else {
    stdout = renderText(result);
  }

  return { stdout, exitCode };
}

function renderText(result: Awaited<ReturnType<typeof replayProofBundle>>): string {
  const lines: string[] = [];
  lines.push(
    `Verified ${result.proofs.length} proof(s): ` +
      `passed=${result.passed} failed=${result.failed} incomplete=${result.incomplete}`,
  );
  for (const entry of result.proofs) {
    const reason = entry.reason ? ` (${entry.reason})` : "";
    const keyId = entry.signing_key_id ? ` key=${entry.signing_key_id}` : "";
    lines.push(
      `  ${entry.proof_id}  ${entry.verification_status}${keyId}${reason}`,
    );
  }
  return lines.join("\n") + "\n";
}
