import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyEvidenceBundle, VerifyError } from "./verify.js";
import type { EvidenceBundle, KeySet } from "./verify.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function usage(): void {
  process.stderr.write(
    [
      "atlasent-verify — offline verification of an AtlaSent evidence bundle",
      "",
      "Usage:",
      "  atlasent-verify [bundle.json] [trust-root.json] [--json]",
      "",
      "Defaults:",
      "  bundle.json      ./bundle.json",
      "  trust-root.json  ./trust-root.json",
      "",
      "Options:",
      "  --json   Output machine-readable JSON",
      "  --help   Show this help text",
      "",
      "Exit codes:",
      "  0  PASS — all checks passed",
      "  1  FAIL — one or more checks failed",
      "  2  Usage / file-read error",
      "",
    ].join("\n"),
  );
}

export function main(argv: string[] = process.argv.slice(2)): number {
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    return 0;
  }

  const jsonOutput = argv.includes("--json");
  const positional = argv.filter((a) => !a.startsWith("--"));

  const bundlePath = positional[0] ?? resolve(HERE, "bundle.json");
  const keysetPath = positional[1] ?? resolve(HERE, "trust-root.json");

  let bundle: EvidenceBundle;
  let keySet: KeySet;
  try {
    bundle = JSON.parse(readFileSync(bundlePath, "utf8")) as EvidenceBundle;
    keySet = JSON.parse(readFileSync(keysetPath, "utf8")) as KeySet;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify({ ok: false, error: `cannot read input: ${msg}` }) + "\n");
    } else {
      process.stderr.write(`error: cannot read input: ${msg}\n`);
    }
    return 2;
  }

  try {
    const r = verifyEvidenceBundle(bundle, keySet);
    if (jsonOutput) {
      process.stdout.write(JSON.stringify(r) + "\n");
    } else {
      process.stdout.write(
        `PASS  bundle_id=${r.bundle_id ?? "(none)"}  key_id=${r.key_id}  records=${r.record_count}  checks=${r.checks.join(",")}\n`,
      );
    }
    return 0;
  } catch (err) {
    if (err instanceof VerifyError) {
      if (jsonOutput) {
        process.stdout.write(JSON.stringify({ ok: false, error: err.message }) + "\n");
      } else {
        process.stdout.write(`FAIL  ${err.message}\n`);
      }
      return 1;
    }
    throw err;
  }
}
