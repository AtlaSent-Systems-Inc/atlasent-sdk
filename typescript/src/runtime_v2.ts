/**
 * Runtime v2 client — authorized-state-change lifecycle.
 *
 * Thin client over `/v2/orgs/:org_id/…` endpoints landed in
 * `atlasent-api` PR #1031. Accepts the same {@link V2Transport}
 * interface used by the existing v2 batch/stream/graphql module so
 * callers can reuse the same auth headers and fetch implementation.
 *
 * @example
 * ```ts
 * import { RuntimeV2Client } from "@atlasent/sdk/runtime_v2";
 *
 * const rt = new RuntimeV2Client({
 *   baseUrl: "https://api.atlasent.io",
 *   apiKey: process.env.ATLASENT_API_KEY!,
 * });
 * const decision = await rt.authorize("org_acme", { transition: { … } });
 * ```
 */

import { AtlaSentError } from "./errors.js";
import type { V2Transport } from "./v2.js";

// ── Wire types ────────────────────────────────────────────────────────────────

export interface VerificationFailure {
  code: string;
  message: string;
  field?: string;
}

export interface VerificationResult {
  passed: boolean;
  verified_at: string;
  failures: VerificationFailure[];
  warnings: Array<Record<string, unknown>>;
}

export interface ExecutionReceipt {
  receipt_id: string;
  permit_id: string;
  org_id: string;
  issued_at: string;
  post_state_fingerprint: string;
  evidence_id: string;
}

export interface PostExecutionResult {
  verified: boolean;
  evidence_completeness: "COMPLETE" | "PARTIAL" | "FAILED";
  failures: VerificationFailure[];
  receipt?: ExecutionReceipt;
}

export interface AuthorizationDecision {
  status: "PERMITTED" | "PENDING_APPROVAL" | "DENIED" | "ERROR";
  permit?: Record<string, unknown>;
  required_approvers?: string[];
  reasons?: string[];
  policy_ids?: string[];
  code?: string;
  message?: string;
}

export interface AuthorityRecord {
  authority_id: string;
  org_id: string;
  name: string;
  action_classes: string[];
  public_key: string;
  key_id: string;
  status: string;
  created_at: string;
  [key: string]: unknown;
}

export interface RuntimeAuditEntry {
  entry_id: string;
  org_id: string;
  sequence: number;
  receipt_id: string;
  prior_hash: string;
  entry_hash: string;
  appended_at: string;
}

export interface AuditChainPage {
  entries: RuntimeAuditEntry[];
  total: number;
  page: number;
  page_size: number;
}

export interface ChainIntegrityReport {
  valid: boolean;
  checked_entries: number;
  first_sequence: number;
  last_sequence: number;
  gaps: number[];
  invalid_hashes: number[];
  verified_at: string;
}

export interface ComplianceExport {
  export_id: string;
  org_id: string;
  from: string;
  to: string;
  entry_count: number;
  format: string;
  content_ref: string;
  content_hash: string;
  generated_at: string;
  signed_by: string;
}

export interface AuditChainFilters {
  action_class?: string;
  principal_did?: string;
  resource_locator?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function orgPath(orgId: string, ...parts: string[]): string {
  const base = `/v2/orgs/${orgId}`;
  return parts.length ? `${base}/${parts.join("/")}` : base;
}

function headers(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
}

function pickFetch(t: V2Transport): typeof fetch {
  if (t.fetch !== undefined) return t.fetch;
  if (typeof fetch !== "undefined") return fetch;
  throw new Error(
    "runtime_v2: no fetch available (set transport.fetch or run Node ≥ 18)",
  );
}

async function doPost(
  t: V2Transport,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const f = pickFetch(t);
  const res = await f(`${t.baseUrl}${path}`, {
    method: "POST",
    headers: headers(t.apiKey),
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data["error"] as Record<string, unknown>) ?? {};
    throw new AtlaSentError(
      String(err["message"] ?? `POST ${path} failed (${res.status})`),
      { status: res.status },
    );
  }
  return data;
}

async function doGet(
  t: V2Transport,
  path: string,
  params?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const f = pickFetch(t);
  const url = new URL(`${t.baseUrl}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  }
  const res = await f(url.toString(), {
    method: "GET",
    headers: headers(t.apiKey),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = (data["error"] as Record<string, unknown>) ?? {};
    throw new AtlaSentError(
      String(err["message"] ?? `GET ${path} failed (${res.status})`),
      { status: res.status },
    );
  }
  return data;
}

async function doDelete(
  t: V2Transport,
  path: string,
  body: unknown,
): Promise<void> {
  const f = pickFetch(t);
  const res = await f(`${t.baseUrl}${path}`, {
    method: "DELETE",
    headers: headers(t.apiKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const err = (data["error"] as Record<string, unknown>) ?? {};
    throw new AtlaSentError(
      String(err["message"] ?? `DELETE ${path} failed (${res.status})`),
      { status: res.status },
    );
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

/** Runtime v2 client — four-plane authorized-state-change lifecycle. */
export class RuntimeV2Client {
  constructor(private readonly transport: V2Transport) {}

  // ── Control plane ────────────────────────────────────────────────────────────

  /** `POST /v2/orgs/:orgId/transitions` */
  async authorize(
    orgId: string,
    request: Record<string, unknown>,
  ): Promise<AuthorizationDecision> {
    const data = await doPost(this.transport, orgPath(orgId, "transitions"), request);
    const permit = data["permit"] as Record<string, unknown> | undefined;
    const code = data["code"] as string | undefined;
    const message = data["message"] as string | undefined;
    return {
      status: data["status"] as AuthorizationDecision["status"],
      ...(permit !== undefined ? { permit } : {}),
      required_approvers: (data["required_approvers"] as string[] | undefined) ?? [],
      reasons: (data["reasons"] as string[] | undefined) ?? [],
      policy_ids: (data["policy_ids"] as string[] | undefined) ?? [],
      ...(code !== undefined ? { code } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }

  // ── Permit plane ─────────────────────────────────────────────────────────────

  /** `GET /v2/orgs/:orgId/permits/:permitId` */
  async getPermit(
    orgId: string,
    permitId: string,
  ): Promise<Record<string, unknown> | null> {
    const data = await doGet(this.transport, orgPath(orgId, "permits", permitId));
    return (data["permit"] as Record<string, unknown>) ?? null;
  }

  /** `POST /v2/orgs/:orgId/permits/:permitId/consume` */
  async consume(
    orgId: string,
    permitId: string,
    observedSourceFingerprint: string,
  ): Promise<VerificationResult> {
    const data = await doPost(
      this.transport,
      orgPath(orgId, "permits", permitId, "consume"),
      { observed_source_fingerprint: observedSourceFingerprint },
    );
    return {
      passed: Boolean(data["passed"]),
      verified_at: String(data["verified_at"] ?? ""),
      failures: ((data["failures"] as VerificationFailure[]) ?? []),
      warnings: ((data["warnings"] as Array<Record<string, unknown>>) ?? []),
    };
  }

  /** `POST /v2/orgs/:orgId/permits/:permitId/approve` */
  async approve(
    orgId: string,
    permitId: string,
    approverDid: string,
    signature: string,
    comment?: string,
  ): Promise<{ approved: boolean; status: string }> {
    const body: Record<string, unknown> = { approver_did: approverDid, signature };
    if (comment !== undefined) body["comment"] = comment;
    const data = await doPost(
      this.transport,
      orgPath(orgId, "permits", permitId, "approve"),
      body,
    );
    return {
      approved: Boolean(data["approved"]),
      status: String(data["status"] ?? ""),
    };
  }

  /** `POST /v2/orgs/:orgId/permits/:permitId/complete` */
  async complete(
    orgId: string,
    permitId: string,
    evidenceId: string,
    observedPostFingerprint: string,
  ): Promise<PostExecutionResult> {
    const data = await doPost(
      this.transport,
      orgPath(orgId, "permits", permitId, "complete"),
      { evidence_id: evidenceId, observed_post_fingerprint: observedPostFingerprint },
    );
    const rd = data["receipt"] as Record<string, unknown> | undefined;
    const receipt: ExecutionReceipt | undefined = rd
      ? {
          receipt_id: String(rd["receipt_id"] ?? ""),
          permit_id: String(rd["permit_id"] ?? ""),
          org_id: String(rd["org_id"] ?? ""),
          issued_at: String(rd["issued_at"] ?? ""),
          post_state_fingerprint: String(rd["post_state_fingerprint"] ?? ""),
          evidence_id: String(rd["evidence_id"] ?? ""),
        }
      : undefined;
    return {
      verified: Boolean(data["verified"]),
      evidence_completeness: (data["evidence_completeness"] as PostExecutionResult["evidence_completeness"]) ?? "FAILED",
      failures: ((data["failures"] as VerificationFailure[]) ?? []),
      ...(receipt !== undefined ? { receipt } : {}),
    };
  }

  /** `DELETE /v2/orgs/:orgId/permits/:permitId` */
  async revokePermit(
    orgId: string,
    permitId: string,
    revokedBy: string,
    reason: string,
    propagatesToChildren = false,
  ): Promise<void> {
    await doDelete(
      this.transport,
      orgPath(orgId, "permits", permitId),
      { revoked_by: revokedBy, reason, propagates_to_children: propagatesToChildren },
    );
  }

  // ── Authority plane ──────────────────────────────────────────────────────────

  /** `GET /v2/orgs/:orgId/authorities` */
  async listAuthorities(
    orgId: string,
    includeInactive = false,
  ): Promise<AuthorityRecord[]> {
    const params: Record<string, string> = {};
    if (includeInactive) params["include_inactive"] = "true";
    const data = await doGet(this.transport, orgPath(orgId, "authorities"), params);
    return (data["authorities"] as AuthorityRecord[]) ?? [];
  }

  /** `POST /v2/orgs/:orgId/authorities` */
  async createAuthority(
    orgId: string,
    record: Record<string, unknown>,
  ): Promise<AuthorityRecord> {
    const data = await doPost(this.transport, orgPath(orgId, "authorities"), record);
    return (data["authority"] ?? data) as AuthorityRecord;
  }

  /** `GET /v2/orgs/:orgId/authorities/:authorityId` */
  async getAuthority(
    orgId: string,
    authorityId: string,
  ): Promise<AuthorityRecord | null> {
    const data = await doGet(this.transport, orgPath(orgId, "authorities", authorityId));
    return (data["authority"] as AuthorityRecord) ?? null;
  }

  /** `POST /v2/orgs/:orgId/authorities/:authorityId/rotate` */
  async rotateAuthority(
    orgId: string,
    authorityId: string,
    newPublicKey: string,
    newKeyId: string,
  ): Promise<AuthorityRecord> {
    const data = await doPost(
      this.transport,
      orgPath(orgId, "authorities", authorityId, "rotate"),
      { new_public_key: newPublicKey, new_key_id: newKeyId },
    );
    return (data["authority"] ?? data) as AuthorityRecord;
  }

  /** `POST /v2/orgs/:orgId/authorities/:authorityId/revoke` */
  async revokeAuthority(
    orgId: string,
    authorityId: string,
    reason: string,
  ): Promise<void> {
    await doPost(
      this.transport,
      orgPath(orgId, "authorities", authorityId, "revoke"),
      { reason },
    );
  }

  // ── Evidence plane ───────────────────────────────────────────────────────────

  /** `POST /v2/orgs/:orgId/evidence` */
  async submitEvidence(
    orgId: string,
    pkg: Record<string, unknown>,
  ): Promise<void> {
    await doPost(this.transport, orgPath(orgId, "evidence"), pkg);
  }

  /** `GET /v2/orgs/:orgId/evidence/:evidenceId` */
  async getEvidence(
    orgId: string,
    evidenceId: string,
  ): Promise<Record<string, unknown> | null> {
    const data = await doGet(
      this.transport,
      orgPath(orgId, "evidence", evidenceId),
    );
    return (data["evidence"] as Record<string, unknown>) ?? null;
  }

  /** `GET /v2/orgs/:orgId/audit-chain` */
  async queryAuditChain(
    orgId: string,
    from: string,
    to: string,
    options?: AuditChainFilters & { page?: number; page_size?: number },
  ): Promise<AuditChainPage> {
    const params: Record<string, string> = { from, to };
    if (options?.page !== undefined) params["page"] = String(options.page);
    if (options?.page_size !== undefined) params["page_size"] = String(options.page_size);
    if (options?.action_class) params["action_class"] = options.action_class;
    if (options?.principal_did) params["principal_did"] = options.principal_did;
    if (options?.resource_locator) params["resource_locator"] = options.resource_locator;
    const data = await doGet(this.transport, orgPath(orgId, "audit-chain"), params);
    return {
      entries: (data["entries"] as RuntimeAuditEntry[]) ?? [],
      total: Number(data["total"] ?? 0),
      page: Number(data["page"] ?? 1),
      page_size: Number(data["page_size"] ?? 100),
    };
  }

  /** `GET /v2/orgs/:orgId/audit-chain/integrity` */
  async verifyChainIntegrity(
    orgId: string,
    fromSequence: number,
    toSequence: number,
  ): Promise<ChainIntegrityReport> {
    const data = await doGet(
      this.transport,
      orgPath(orgId, "audit-chain", "integrity"),
      { from_sequence: String(fromSequence), to_sequence: String(toSequence) },
    );
    return {
      valid: Boolean(data["valid"]),
      checked_entries: Number(data["checked_entries"] ?? 0),
      first_sequence: Number(data["first_sequence"] ?? fromSequence),
      last_sequence: Number(data["last_sequence"] ?? toSequence),
      gaps: (data["gaps"] as number[]) ?? [],
      invalid_hashes: (data["invalid_hashes"] as number[]) ?? [],
      verified_at: String(data["verified_at"] ?? ""),
    };
  }

  /** `POST /v2/orgs/:orgId/compliance-export` */
  async exportCompliance(
    orgId: string,
    from: string,
    to: string,
    format: "JSON" | "CSV" | "CISA_SBOM" = "JSON",
  ): Promise<ComplianceExport> {
    const data = await doPost(
      this.transport,
      orgPath(orgId, "compliance-export"),
      { from, to, format },
    );
    return {
      export_id: String(data["export_id"] ?? ""),
      org_id: String(data["org_id"] ?? orgId),
      from: String(data["from"] ?? from),
      to: String(data["to"] ?? to),
      entry_count: Number(data["entry_count"] ?? 0),
      format: String(data["format"] ?? format),
      content_ref: String(data["content_ref"] ?? ""),
      content_hash: String(data["content_hash"] ?? ""),
      generated_at: String(data["generated_at"] ?? ""),
      signed_by: String(data["signed_by"] ?? ""),
    };
  }
}
