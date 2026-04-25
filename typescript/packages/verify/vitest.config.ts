import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      // CLI is exercised end-to-end via spawnSync; lines/funcs floor 95.
      thresholds: {
        lines: 95,
        branches: 80,
        functions: 95,
        statements: 95,
      },
    },
  },
});
