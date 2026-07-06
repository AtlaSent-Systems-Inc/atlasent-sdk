/**
 * Size Limit configuration for @atlasent/sdk.
 *
 * Measured limits (gzip, after tree-shaking with esbuild):
 *   core path (protect + requirePermit):           ~13.1 kB  → limit 16.5 kB
 *     (bumped from 15 kB: catalog.ts added ~902 B to the tree-shaken bundle)
 *   core + webhook + streaming errors:             ~13.6 kB  → limit 18 kB
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
    limit: "16.5 kB",
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
    limit: "18 kB",
    modifyEsbuildConfig(config) {
      config.platform = "node";
      return config;
    },
  },
];
