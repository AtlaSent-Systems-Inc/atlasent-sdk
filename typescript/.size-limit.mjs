/**
 * Size Limit configuration for @atlasent/sdk.
 *
 * Measured limits (gzip, after tree-shaking with esbuild):
 *   core path (protect + requirePermit):           ~18.1 kB  → limit 19 kB
 *     (bumped 16.5→19 kB: full 17-action catalog with gate flags, regulatory
 *      mappings, and sales data contributes to the tree-shaken bundle)
 *   core + webhook + streaming errors:             ~18.5 kB  → limit 19.5 kB
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
    limit: "19 kB",
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
    limit: "19.5 kB",
    modifyEsbuildConfig(config) {
      config.platform = "node";
      return config;
    },
  },
];
