/**
 * Size Limit configuration for @atlasent/sdk.
 *
 * Measured limits (gzip, after tree-shaking with esbuild):
 *   core path (protect + requirePermit):           ~21.8 kB  → limit 23 kB
 *     (bumped 19→23 kB: the canonical action catalog grew 17→29 actions
 *      — with gate flags, regulatory mappings, and sales data — and rides
 *      in the tree-shaken core bundle; prior bump was 16.5→19 kB at 17 actions)
 *   core + webhook + streaming errors:             ~22.1 kB  → limit 23.5 kB
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
    limit: "23 kB",
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
    limit: "23.5 kB",
    modifyEsbuildConfig(config) {
      config.platform = "node";
      return config;
    },
  },
];
