import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const V1_EXAMPLE_FILES = [
  "examples/deploy-gate.ts",
  "examples/protect.ts",
  "README.md",
];

describe("Deploy Gate V1 examples", () => {
  it("use deployment.production and not old production.deploy/deploy_to_production names", async () => {
    for (const file of V1_EXAMPLE_FILES) {
      const text = await readFile(file, "utf8");
      expect(text, file).toContain("deployment.production");
      expect(text, file).not.toContain("production.deploy");
      expect(text, file).not.toContain("deploy_to_production");
    }
  });
});
