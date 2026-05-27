/**
 * Evidence Bundle helpers — create, retrieve, and download compliance
 * evidence bundles for incident investigations and audit export.
 *
 * Wire surface: POST/GET /v1/evidence-bundles
 *
 * Usage:
 *
 * ```ts
 * import { AtlaSentClient } from "@atlasent/sdk";
 *
 * const client = new AtlaSentClient({ apiKey: "..." });
 *
 * // Create
 * const bundle = await client.evidenceBundles.create({
 *   incidentId: "inc_abc123",
 *   includeOverrides: true,
 * });
 *
 * // Get
 * const bundle2 = await client.evidenceBundles.get(bundle.bundleId);
 *
 * // Download as JSON or PDF
 * const pdf = await client.evidenceBundles.download(bundle.bundleId, "pdf");
 * ```
 */

/** Status of an evidence bundle. */
export type EvidenceBundleStatus =
  | "pending"
  | "building"
  | "ready"
  | "failed"
  | "expired";

/** An evidence bundle record returned by the API. */
export interface EvidenceBundle {
  /** Server-assigned bundle identifier. */
  bundleId: string;
  /** Organisation the bundle belongs to. */
  orgId: string;
  /** Incident or investigation ID this bundle was created for. */
  incidentId: string;
  /** Current bundle status. */
  status: EvidenceBundleStatus;
  /** Permit IDs included in the bundle (empty = all permits for the incident). */
  includedPermits: string[];
  /** Whether override events are included. */
  includeOverrides: boolean;
  /** Format used when the bundle was created. */
  format: "json" | "pdf";
  /** ISO 8601 creation time. */
  createdAt: string;
  /** ISO 8601 expiration time. */
  expiresAt: string;
  /** Pre-signed download URL (populated when status is `ready`). */
  downloadUrl?: string;
  /** Free-form metadata supplied at creation. */
  metadata?: Record<string, unknown>;
}

/** Input to {@link EvidenceBundlesMixin.create}. */
export interface EvidenceBundleCreateParams {
  /** Incident or investigation ID for this bundle. */
  incidentId: string;
  /**
   * Optional list of specific permit IDs to include.
   * When omitted, all permits associated with the incident are included.
   */
  includedPermits?: string[];
  /**
   * When `true`, override events are embedded in the bundle.
   * Defaults to `false`.
   */
  includeOverrides?: boolean;
}

/** Wire shape returned by POST /v1/evidence-bundles. */
interface EvidenceBundleWire {
  bundle_id: string;
  org_id: string;
  incident_id: string;
  status: EvidenceBundleStatus;
  included_permits: string[];
  include_overrides: boolean;
  format: "json" | "pdf";
  created_at: string;
  expires_at: string;
  download_url?: string;
  metadata?: Record<string, unknown>;
}

function wireToBundle(w: EvidenceBundleWire): EvidenceBundle {
  return {
    bundleId: w.bundle_id,
    orgId: w.org_id,
    incidentId: w.incident_id,
    status: w.status,
    includedPermits: w.included_permits ?? [],
    includeOverrides: w.include_overrides ?? false,
    format: w.format,
    createdAt: w.created_at,
    expiresAt: w.expires_at,
    ...(w.download_url !== undefined ? { downloadUrl: w.download_url } : {}),
    ...(w.metadata !== undefined ? { metadata: w.metadata } : {}),
  };
}

/**
 * Sub-client for evidence bundle operations.
 * Accessed as `client.evidenceBundles` on {@link AtlaSentClient}.
 */
export interface EvidenceBundleSubClient {
  /**
   * Create a new evidence bundle.
   *
   * ```ts
   * const bundle = await client.evidenceBundles.create({
   *   incidentId: "inc_abc123",
   *   includeOverrides: true,
   * });
   * ```
   */
  create(params: EvidenceBundleCreateParams): Promise<EvidenceBundle>;

  /**
   * Retrieve an evidence bundle by ID.
   *
   * ```ts
   * const bundle = await client.evidenceBundles.get("bnd_xyz");
   * ```
   */
  get(bundleId: string): Promise<EvidenceBundle>;

  /**
   * Download the evidence bundle contents.
   *
   * @param bundleId - The bundle to download.
   * @param format   - `"json"` (default) or `"pdf"`.
   * @returns Raw bytes of the downloaded file.
   *
   * ```ts
   * const pdf = await client.evidenceBundles.download("bnd_xyz", "pdf");
   * await fs.writeFile("bundle.pdf", pdf);
   * ```
   */
  download(bundleId: string, format?: "json" | "pdf"): Promise<Buffer>;
}

/**
 * Factory that returns the evidence-bundles sub-client bound to a host
 * client. Called internally by AtlaSentClient; not part of the public
 * constructor API.
 */
export function makeEvidenceBundleClient(
  postFn: <T>(path: string, body: unknown) => Promise<{ body: T }>,
  getFn: <T>(path: string, query?: URLSearchParams) => Promise<{ body: T }>,
  getRawFn: (path: string) => Promise<ArrayBuffer>,
): EvidenceBundleSubClient {
  return {
    async create(params: EvidenceBundleCreateParams): Promise<EvidenceBundle> {
      const payload: Record<string, unknown> = {
        incident_id: params.incidentId,
      };
      if (params.includedPermits !== undefined) {
        payload["included_permits"] = params.includedPermits;
      }
      if (params.includeOverrides !== undefined) {
        payload["include_overrides"] = params.includeOverrides;
      }
      const { body } = await postFn<EvidenceBundleWire>(
        "/v1/evidence-bundles",
        payload,
      );
      return wireToBundle(body);
    },

    async get(bundleId: string): Promise<EvidenceBundle> {
      const { body } = await getFn<EvidenceBundleWire>(
        `/v1/evidence-bundles/${encodeURIComponent(bundleId)}`,
      );
      return wireToBundle(body);
    },

    async download(
      bundleId: string,
      format: "json" | "pdf" = "json",
    ): Promise<Buffer> {
      const qs = new URLSearchParams({ format });
      const raw = await getRawFn(
        `/v1/evidence-bundles/${encodeURIComponent(bundleId)}/download?${qs}`,
      );
      return Buffer.from(raw);
    },
  };
}
