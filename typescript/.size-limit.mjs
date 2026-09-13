/**
 * Size Limit configuration for @atlasent/sdk.
 *
 * Measured limits (gzip, after tree-shaking with esbuild):
 *   core path (protect + requirePermit):           ~23.0 kB  → limit 23.5 kB
 *     (bumped 23→23.5 kB 2026-09-13: the embedded trust-root snapshot
 *      (vendoredTrustRoot.generated.ts, which rides in the core bundle since
 *      #517 moved it off disk) gained the production audit key `v1` and the
 *      `v2-audit-2026` revocation entry with its ledger reason — measured
 *      23.03 kB, 31 B over the old ceiling. Prior bump was 19→23 kB when the
 *      canonical action catalog grew 17→29 actions; before that 16.5→19 kB.)
 *   core + webhook + streaming errors:             ~23.45 kB → limit 24 kB
 *     (bumped 23.5→24 kB in the same change, same cause, to keep headroom)
 *
 * `modifyEsbuildConfig` sets `platform: "node"` so built-in Node modules
 * (crypto, fs/promises) are treated as external and not counted toward size.
 * This matches how the SDK is consumed in server/agent environments.
 */

/** @type {import('size-limit').SizeLimitConfig} */
export default [
  {
    name: "core (protect + requirePermit)",
    path: "dist/index.js",
    import: "{ protect, requirePermit }",
    limit: "23.5 kB",
    modifyEsbuildConfig(config) {
      config.platform = "node";
      return config;
    },
  },
  {
    name: "core + webhooks + streaming errors",
    path: "dist/index.js",
    import:
      "{ protect, requirePermit, verifyWebhook, assertWebhook, StreamTimeoutError, StreamParseError }",
    limit: "24 kB",
    modifyEsbuildConfig(config) {
      config.platform = "node";
      return config;
    },
  },
];
