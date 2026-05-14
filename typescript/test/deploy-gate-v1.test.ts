import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const V1_EXAMPLE_FILES = [
  "examples/deploy-gate.ts",
  "examples/protect.ts",
  "README.md",
];

describe("Deploy Gate V1 examples", () => {
  // V1 canonical was switched from `deployment.production` to
  // `production.deploy` (atlasent-api PR #662, atlasent-console
  // PR #432). Examples must show the new canonical; the legacy name
  // is still alias-tolerated on the wire but should not appear in
  // user-facing examples. `deploy_to_production` was never canonical
  // and stays forbidden.
  it("use production.deploy and not old deployment.production/deploy_to_production names", async () => {
    for (const file of V1_EXAMPLE_FILES) {
      const text = await readFile(file, "utf8");
      expect(text, file).toContain("production.deploy");
      expect(text, file).not.toContain("deployment.production");
      expect(text, file).not.toContain("deploy_to_production");
    }
  });
});
