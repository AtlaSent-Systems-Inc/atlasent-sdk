/**
 * Ensures every src/ module that only re-exports TypeScript types is
 * evaluated at runtime so V8 coverage counts it.  Without this, vitest's
 * `include: ["src/**\/*.ts"]` adds them to the report but they register
 * 0 % because they're never imported by any other test.
 *
 * Each dynamic import forces ESM module initialisation.  For pure-type
 * files the compiled output is `export {};` — one executed statement —
 * which is enough to bring the file into the covered set.
 */

import { describe, expect, it } from "vitest";

describe("all type-only modules load without error", () => {
  it.each([
    "../src/actionDependencies.js",
    "../src/approvalsSla.js",
    "../src/engineVersions.js",
    "../src/financialGovernance.js",
    "../src/governanceGraph.js",
    "../src/identityAssertion.js",
    "../src/incidentReconstruction.js",
    "../src/orgRiskGraph.js",
    "../src/overrides.js",
    "../src/policyCertification.js",
    "../src/proof.js",
    "../src/rbacRules.js",
    "../src/snapshots.js",
    "../src/v1Types.js",
    "../src/verticals/index.js",
  ])("module %s initialises", async (path) => {
    const mod = await import(path);
    expect(mod).toBeDefined();
  });
});
