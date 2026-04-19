import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**", "node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // Floors, set to current-minus-small-margin so CI catches
      // regressions. V1 target per docs/V1_PLAN.md is lines 95 /
      // branches 85 — ratchet up as tests are added for timeout,
      // 5xx retry, and edge-case JSON paths in client.ts.
      thresholds: {
        lines: 94,
        branches: 68,
        functions: 95,
        statements: 94,
      },
    },
  },
});
