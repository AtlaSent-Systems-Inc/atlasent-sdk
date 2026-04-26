/**
 * Tests for the offline-verifier CLI.
 *
 * Strategy: call `run()` directly (no subprocess) so each test
 * exercises the full parse → load → replay → format pipeline
 * against the on-disk fixtures from PR #66, with exit codes /
 * stdout / stderr captured into the returned `RunResult`.
 *
 * The bin shim (`bin/atlasent-v2-verify.mjs`) is tested separately
 * by the smoke check in the PR body — it just forwards argv and
 * exit code to `run()`.
 */

import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  loadBundle,
  parseArgs,
  parseKeySpec,
  run,
} from "../src/cli/verify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "contract",
  "vectors",
  "v2",
  "proof-bundles",
);

const VALID = resolve(FIXTURES, "valid.json");
const TAMPERED = resolve(FIXTURES, "tampered-payload.json");
const PENDING = resolve(FIXTURES, "pending.json");
const ACTIVE_KEY_SPEC = `v2-proof-key-active=${resolve(FIXTURES, "signing-key.pub.pem")}`;
const ACTIVE_KEY_BARE = resolve(FIXTURES, "signing-key.pub.pem");
const OTHER_KEY_SPEC = `v2-proof-key-other=${resolve(FIXTURES, "other-key.pub.pem")}`;

// ── parseArgs ─────────────────────────────────────────────────────


describe("parseArgs", () => {
  it("requires a bundle path", () => {
    expect(() => parseArgs([])).toThrow(CliUsageError);
    expect(() => parseArgs([])).toThrow(/missing required <bundle.json>/);
  });

  it("accepts a bare bundle path with no flags", () => {
    expect(parseArgs(["bundle.json"])).toEqual({
      bundlePath: "bundle.json",
      keyPaths: [],
      strict: false,
      format: "json",
    });
  });

  it("accepts repeated --key arguments", () => {
    const parsed = parseArgs(["--key", "k1.pem", "--key", "k2.pem", "bundle.json"]);
    expect(parsed.keyPaths).toEqual(["k1.pem", "k2.pem"]);
  });

  it("--key without a following value is rejected", () => {
    expect(() => parseArgs(["--key"])).toThrow(/--key requires a path/);
    expect(() => parseArgs(["--key", "--strict", "bundle.json"])).toThrow(
      /--key requires a path/,
    );
  });

  it("flips --strict on", () => {
    const parsed = parseArgs(["--strict", "bundle.json"]);
    expect(parsed.strict).toBe(true);
  });

  it("--text overrides default --json", () => {
    const parsed = parseArgs(["--text", "bundle.json"]);
    expect(parsed.format).toBe("text");
  });

  it("--json explicit selection works", () => {
    const parsed = parseArgs(["--json", "bundle.json"]);
    expect(parsed.format).toBe("json");
  });

  it("rejects unknown options", () => {
    expect(() => parseArgs(["--nope", "bundle.json"])).toThrow(
      /unknown option: --nope/,
    );
  });

  it("rejects multiple positional args", () => {
    expect(() => parseArgs(["bundle1.json", "bundle2.json"])).toThrow(
      /unexpected positional/,
    );
  });

  it("--help and -h request the help screen", () => {
    expect(() => parseArgs(["--help"])).toThrow(/__help__/);
    expect(() => parseArgs(["-h"])).toThrow(/__help__/);
  });
});

// ── parseKeySpec ──────────────────────────────────────────────────


describe("parseKeySpec", () => {
  it("derives keyId from basename when no '=' is present", () => {
    expect(parseKeySpec("/path/to/audit-key.pub.pem")).toEqual({
      keyId: "audit-key",
      path: "/path/to/audit-key.pub.pem",
    });
    expect(parseKeySpec("./key.pem")).toEqual({
      keyId: "key",
      path: "./key.pem",
    });
    expect(parseKeySpec("plain")).toEqual({
      keyId: "plain",
      path: "plain",
    });
  });

  it("uses the explicit id from id=path form", () => {
    expect(parseKeySpec("v2-proof-key-active=/path/to/key.pem")).toEqual({
      keyId: "v2-proof-key-active",
      path: "/path/to/key.pem",
    });
  });

  it("rejects malformed id=path with empty id or path", () => {
    expect(() => parseKeySpec("=path.pem")).toThrow(/must be either/);
    expect(() => parseKeySpec("=")).toThrow(/must be either/);
    // 'id=' has empty path → reject.
    expect(() => parseKeySpec("id=")).toThrow(/must be either/);
  });
});

// ── loadBundle ────────────────────────────────────────────────────


describe("loadBundle", () => {
  it("reads a {proofs:[...]} wrapper (the shared fixture format)", async () => {
    const proofs = await loadBundle(VALID);
    expect(proofs).toHaveLength(3);
    expect(proofs[0]?.proof_id).toMatch(/^proof-00/);
  });

  it("throws on a non-existent file", async () => {
    await expect(loadBundle("/no/such/file.json")).rejects.toThrow(/ENOENT/);
  });
});

// ── run — happy paths ────────────────────────────────────────────


describe("run — happy paths", () => {
  it("verifies valid.json with explicit key id, exit 0, JSON output", async () => {
    const result = await run(["--key", ACTIVE_KEY_SPEC, VALID]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      passed: number;
      failed: number;
      incomplete: number;
    };
    expect(parsed.passed).toBe(3);
    expect(parsed.failed).toBe(0);
  });

  it("text format produces one line per proof + summary", async () => {
    const result = await run(["--text", "--key", ACTIVE_KEY_SPEC, VALID]);
    expect(result.exitCode).toBe(0);
    const lines = result.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/passed=3 failed=0/);
    expect(lines).toHaveLength(4); // summary + 3 proofs
  });

  it("bare-path key spec works (basename-derived id)", async () => {
    // No '=' — keyId becomes "signing-key". Doesn't match the proof's
    // signing_key_id "v2-proof-key-active", so the verifier falls
    // through to "any other key" — succeeds anyway.
    const result = await run(["--key", ACTIVE_KEY_BARE, VALID]);
    expect(result.exitCode).toBe(0);
  });
});

// ── run — failure paths ──────────────────────────────────────────


describe("run — failure paths", () => {
  it("tampered-payload exits 1 with invalid_signature reason", async () => {
    const result = await run(["--text", "--key", ACTIVE_KEY_SPEC, TAMPERED]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toMatch(/passed=2 failed=1/);
    expect(result.stdout).toMatch(/invalid_signature/);
  });

  it("pending in non-strict mode exits 0 with incomplete=1", async () => {
    const result = await run(["--key", ACTIVE_KEY_SPEC, PENDING]);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout) as { incomplete: number; failed: number };
    expect(parsed.incomplete).toBe(1);
    expect(parsed.failed).toBe(0);
  });

  it("pending under --strict exits 1 with failed=1", async () => {
    const result = await run(["--strict", "--key", ACTIVE_KEY_SPEC, PENDING]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { incomplete: number; failed: number };
    expect(parsed.failed).toBe(1);
  });

  it("wrong key set yields all-fail exit 1", async () => {
    // Verify the active-signed valid bundle with ONLY the other key.
    // The hint matches no key in the trust set; rotation fallback
    // tries the other key, which doesn't have the signing material →
    // every proof fails.
    const result = await run(["--key", OTHER_KEY_SPEC, VALID]);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stdout) as { failed: number };
    expect(parsed.failed).toBe(3);
  });
});

// ── run — usage / error paths ────────────────────────────────────


describe("run — usage / error paths", () => {
  it("missing bundle path → exit 2 with usage on stderr", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr ?? "").toMatch(/missing required/);
    expect(result.stderr ?? "").toMatch(/Usage:/);
  });

  it("--help → exit 0 with usage on stdout", async () => {
    const result = await run(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Usage:/);
    expect(result.stderr).toBeUndefined();
  });

  it("non-existent bundle → exit 2 with file error on stderr", async () => {
    const result = await run(["--key", ACTIVE_KEY_SPEC, "/no/such/bundle.json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr ?? "").toMatch(/ENOENT/);
  });

  it("non-existent key → exit 2 with key load error on stderr", async () => {
    const result = await run(["--key", "id=/no/such/key.pem", VALID]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr ?? "").toMatch(/failed to load key file/);
  });

  it("unknown option → exit 2 with usage", async () => {
    const result = await run(["--bogus", "bundle.json"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr ?? "").toMatch(/unknown option: --bogus/);
    expect(result.stderr ?? "").toMatch(/Usage:/);
  });
});
