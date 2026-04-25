/**
 * @atlasent/verify — zero-dependency offline verifier for AtlaSent
 * signed audit-export bundles.
 *
 * Designed so an auditor can run
 *
 * ```sh
 * npx @atlasent/verify ./bundle.json
 * ```
 *
 * on a fresh machine with no install prerequisites beyond Node 20+.
 *
 * Programmatic usage:
 *
 * ```ts
 * import { verifyBundle } from "@atlasent/verify";
 *
 * const result = await verifyBundle("./bundle.json", {
 *   publicKeysPem: [pem],
 * });
 * if (!result.verified) {
 *   throw new Error(`bundle did not verify: ${result.reason}`);
 * }
 * ```
 *
 * The verification logic is byte-identical with the in-SDK
 * `verifyBundle()` shipped from `@atlasent/sdk` (and with the
 * reference verifier in
 * `atlasent-api/supabase/functions/v1-audit/verify.ts`). The SDK's
 * exported `verifyBundle` is now a thin re-export of this package, so
 * there is exactly one source of truth.
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
} from "./verify.js";
