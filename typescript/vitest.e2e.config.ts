import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["e2e/**/*.test.ts"],
    // E2E tests hit a live API; give each test up to 30 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Run sequentially: the evaluate → permit → audit chain shares state
    // across tests via module-level variables; parallel shards would
    // interleave those reads/writes.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
