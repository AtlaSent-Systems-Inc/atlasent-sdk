/**
 * Offline verification for audit export bundles.
 *
 * The verification logic now lives in the standalone, zero-dependency
 * package `@atlasent/verify` (`typescript/packages/verify/`). This
 * module re-exports it under the original `@atlasent/sdk` import
 * paths so existing consumers keep working — there is exactly one
 * source of truth for the bundle format, and auditors can install
 * the verifier alone via `npx @atlasent/verify`.
 *
 * The relative import inlines the source at SDK-build time (`tsup`
 * bundles dependencies that aren't declared external), so the
 * published `@atlasent/sdk` does not gain a new runtime dependency
 * on `@atlasent/verify` — both packages ship the same code, but
 * neither depends on the other at install time.
 *
 * Primary entry point:
 *
 * ```ts
 * import { verifyBundle } from "@atlasent/sdk";
 * const result = await verifyBundle("export.json", { publicKeysPem: [pem] });
 * ```
 *
 * For new programmatic use prefer `@atlasent/verify`; this re-export
 * exists for back-compat with the v1.4.0 SDK surface.
 */
export {
  canonicalJSON,
  signedBytesFor,
  verifyAuditBundle,
  verifyBundle,
  type AuditBundle,
  type BundleVerificationResult,
  type VerifyBundleOptions,
  type VerifyKey,
} from "../packages/verify/src/verify.js";
