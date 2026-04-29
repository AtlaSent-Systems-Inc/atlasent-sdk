import { execSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadFixture } from "./harness.js";

const fx = loadFixture("SIM-10");
const REPO_ROOT = join(new URL(".", import.meta.url).pathname, "../../../../../");

describe(fx.title, () => {
  it("enforce-no-bypass lint rejects a file that calls evaluate() directly", () => {
    const bypassFixture = join(REPO_ROOT, (fx as unknown as { fixtures: { typescript: string } }).fixtures.typescript);
    const lintScript = join(REPO_ROOT, "scripts/enforce-no-bypass.mjs");

    let exitCode = 0;
    let output = "";
    try {
      output = execSync(`node ${lintScript} ${bypassFixture}`, {
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err: unknown) {
      exitCode = (err as { status?: number }).status ?? 1;
      output = ((err as { stdout?: string }).stdout ?? "") + ((err as { stderr?: string }).stderr ?? "");
    }

    expect(exitCode).toBe(1);
    expect(output.toLowerCase()).toMatch(/enforce-no-bypass|evaluate/);
  });
});
