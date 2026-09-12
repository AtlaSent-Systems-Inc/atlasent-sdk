/**
 * Regression test for the CodeQL "Network data written to file" finding on
 * scripts/vendor-trust-root.mjs (PR #517 review). That script fetches (or
 * reads from a local checkout) untrusted trust-root data and embeds it into
 * committed SDK source that every consumer compiles into their own bundle
 * — it must refuse to do so for malformed input, not write it silently.
 *
 * Runs the real script as a subprocess against fixture directories (never
 * the network), so this exercises the actual CLI behavior a maintainer
 * would see, not just an imported function.
 *
 * IMPORTANT: the script's output path is hardcoded (relative to the
 * script's own location, not the input directory) — it always writes to
 * the real src/vendoredTrustRoot.generated.ts, regardless of which
 * fixture directory supplies the input data. This test therefore backs up
 * that real file before every test and restores it in afterEach
 * (unconditionally, pass or fail), so running this suite never leaves the
 * repo's committed generated file overwritten with test fixture data.
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const SCRIPT = resolve(__dirname, "..", "scripts", "vendor-trust-root.mjs");
const REAL_OUTPUT = resolve(__dirname, "..", "src", "vendoredTrustRoot.generated.ts");

let workdir: string | undefined;
let realOutputBackup: string;

beforeAll(() => {
  realOutputBackup = readFileSync(REAL_OUTPUT, "utf8");
});

function makeFixtureDir(files: Record<string, unknown>): string {
  workdir = mkdtempSync(resolve(tmpdir(), "vendor-trust-root-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(resolve(workdir, name), JSON.stringify(content));
  }
  return workdir;
}

const VALID_FIXTURES = {
  "atlasent-trust-root.json": {
    valid_until: "2027-06-01T00:00:00Z",
    issued_at: "2026-05-28T00:00:00Z",
  },
  "atlasent-verifier-keys.json": {
    keys: [
      { kid: "test-audit-key", role: "R3_audit", kty: "OKP", crv: "Ed25519", alg: "EdDSA", x: "abc" },
    ],
  },
  "atlasent-revocations.json": {
    revoked_keys: [{ kid: "old-key", role: "R3_audit", revoked_at: "2026-01-01T00:00:00Z", reason: "test" }],
    revoked_identities: [],
  },
};

function runScript(dir: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("node", [SCRIPT, dir], { encoding: "utf8" });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string };
    return { status: e.status ?? 1, stdout: e.stdout, stderr: e.stderr };
  }
}

describe("scripts/vendor-trust-root.mjs input validation", () => {
  afterEach(() => {
    if (workdir && existsSync(workdir)) rmSync(workdir, { recursive: true, force: true });
    workdir = undefined;
    // Unconditionally restore the real generated file — see the module
    // header. Every test in this file invokes the real script, which
    // always writes to REAL_OUTPUT regardless of the fixture directory.
    writeFileSync(REAL_OUTPUT, realOutputBackup);
  });

  it("accepts a well-formed fixture and writes the generated module", () => {
    const dir = makeFixtureDir(VALID_FIXTURES);
    const result = runScript(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1 key(s), 1 revocation(s)");
  });

  it("refuses (mutation check) an invalid valid_until instead of writing it", () => {
    const dir = makeFixtureDir({
      ...VALID_FIXTURES,
      "atlasent-trust-root.json": { valid_until: "not-a-date", issued_at: "2026-05-28T00:00:00Z" },
    });
    const result = runScript(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("valid_until must be a parseable ISO-8601 string");
  });

  it("refuses (mutation check) a key with an invalid role instead of writing it", () => {
    const dir = makeFixtureDir({
      ...VALID_FIXTURES,
      "atlasent-verifier-keys.json": {
        keys: [{ kid: "bad", role: "NOT_A_REAL_ROLE", kty: "OKP", alg: "EdDSA" }],
      },
    });
    const result = runScript(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("keys[0].role must be one of");
  });

  it("refuses (mutation check) keys that is not an array", () => {
    const dir = makeFixtureDir({
      ...VALID_FIXTURES,
      "atlasent-verifier-keys.json": { keys: "not-an-array" },
    });
    const result = runScript(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("keys must be an array");
  });

  it("refuses (mutation check) a revocation entry missing kid", () => {
    const dir = makeFixtureDir({
      ...VALID_FIXTURES,
      "atlasent-revocations.json": {
        revoked_keys: [{ role: "R3_audit", revoked_at: "2026-01-01T00:00:00Z" }],
        revoked_identities: [],
      },
    });
    const result = runScript(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("revoked_keys[0].kid must be a non-empty string");
  });
});
