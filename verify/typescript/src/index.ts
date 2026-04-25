/**
 * @atlasent/verify — offline verifier for AtlaSent signed audit-export bundles.
 *
 * This package re-exports the verifier from `@atlasent/sdk` so that
 * customers and auditors can verify a signed export without pulling
 * in the HTTP client, retry, observability, or contract-drift layers
 * of the full SDK.
 *
 * Quick start:
 *
 * ```ts
 * import { verifyBundle } from "@atlasent/verify";
 *
 * const pem = await fetch("https://atlasent.io/.well-known/atlasent-verifier-key.pem")
 *   .then((r) => r.text());
 *
 * const result = await verifyBundle("export.json", { publicKeysPem: [pem] });
 * if (!result.valid) {
 *   throw new Error(`Bundle invalid: ${result.reason}`);
 * }
 * ```
 *
 * The verifier is **byte-identical** with the reference implementation
 * in `atlasent-api/supabase/functions/v1-audit/verify.ts`. A bundle
 * that verifies in the backend verifies here, and vice versa.
 *
 * Status: scaffold. The TypeScript verifier currently lives in
 * `@atlasent/sdk` (path: `typescript/src/auditBundle.ts`) and is
 * re-exported from here with no behavioural change. A subsequent
 * release will relocate the source so this package contains the
 * canonical verifier and `@atlasent/sdk` re-exports from here.
 */

export {
  verifyBundle,
  verifyAuditBundle,
  canonicalJSON,
  signedBytesFor,
  type AuditBundle,
  type BundleVerificationResult,
  type VerifyBundleOptions,
  type VerifyKey,
} from "@atlasent/sdk";

export type {
  AuditDecision,
  AuditEvent,
  AuditExport,
  AuditExportSignatureStatus,
} from "@atlasent/sdk";
