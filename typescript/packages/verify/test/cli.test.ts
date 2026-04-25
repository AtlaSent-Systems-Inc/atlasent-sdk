/**
 * CLI tests for `atlasent-verify`.
 *
 * Runs the `run()` entry point in-process so we don't depend on the
 * tsup-built `dist/cli.js`. The shebang + bin wiring is exercised by
 * the smoke step in CI (`node dist/cli.js …`).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { run } from "../src/cli.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const FIXTURES = resolve(REPO_ROOT, "contract", "vectors", "audit-bundles");

function captureRun(argv: string[]): Promise<{
  code: number;
  out: string[];
  err: string[];
}> {
  const out: string[] = [];
  const err: string[] = [];
  return run(["node", "cli.js", ...argv], (m) => out.push(m), (m) => err.push(m)).then(
    (code) => ({ code, out, err }),
  );
}

describe("atlasent-verify CLI", () => {
  it("prints usage and exits 1 with no args", async () => {
    const { code, err } = await captureRun([]);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Usage:/);
  });

  it("prints usage on --help", async () => {
    const { code, err } = await captureRun(["--help"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Usage:/);
  });

  it("rejects --pem with no path", async () => {
    const { code, err } = await captureRun([resolve(FIXTURES, "valid.json"), "--pem"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Usage:/);
  });

  it("rejects unknown flags", async () => {
    const { code, err } = await captureRun(["--lol"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Usage:/);
  });

  it("rejects two positional arguments", async () => {
    const { code, err } = await captureRun(["a.json", "b.json"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/Usage:/);
  });

  it("verified: false (no PEM, valid bundle) → exit 1, reason on stderr", async () => {
    const { code, out, err } = await captureRun([resolve(FIXTURES, "valid.json")]);
    expect(code).toBe(1);
    expect(out.join("\n")).toBe("verified: false");
    expect(err.join("\n")).toMatch(/reason: no signing keys/);
  });

  it("verified: true with PEM file supplied", async () => {
    const { code, out } = await captureRun([
      resolve(FIXTURES, "valid.json"),
      "--pem",
      resolve(FIXTURES, "signing-key.pub.pem"),
    ]);
    expect(code).toBe(0);
    expect(out.join("\n")).toBe("verified: true");
  });

  it("tampered bundle → exit 1, lists tampered event ids", async () => {
    const { code, out, err } = await captureRun([
      resolve(FIXTURES, "tampered-event.json"),
      "--pem",
      resolve(FIXTURES, "signing-key.pub.pem"),
    ]);
    expect(code).toBe(1);
    expect(out.join("\n")).toBe("verified: false");
    expect(err.join("\n")).toMatch(/tampered_event_ids:/);
  });

  it("missing PEM file surfaces a friendly error and exits 1", async () => {
    const { code, err } = await captureRun([
      resolve(FIXTURES, "valid.json"),
      "--pem",
      "/nonexistent/key.pem",
    ]);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/failed to read PEM/);
  });

  it("missing bundle file surfaces a verifier error and exits 1", async () => {
    const { code, err } = await captureRun(["/nonexistent/bundle.json"]);
    expect(code).toBe(1);
    expect(err.join("\n")).toMatch(/failed to verify/);
  });
});
