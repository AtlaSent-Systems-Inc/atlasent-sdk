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
      // regressions. V1 line target per docs/V1_PLAN.md is 95; branch
      // target is 85. Ratchet branches up once the remaining
      // bad_response non-object path in client.ts is covered.
      thresholds: {
        lines: 95,
        branches: 75,
        functions: 95,
        statements: 95,
      },
    },
  },
});
