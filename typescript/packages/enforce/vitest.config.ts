import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
      include: ["src/**/*.ts"],
    },
  },
});
