/**
 * Authority Intelligence sub-client — read-only authority analysis routes.
 *
 * Wire surface: the `v1-authority-intelligence` edge function. This module
 * exposes exactly one of its sub-routes today:
 *
 * | Sub-route | SDK method | Status |
 * |---|---|---|
 * | `GET /v1-authority-intelligence/integrity-audit` | {@link AuthorityIntelligenceSubClient.integrityAudit} | wrapped |
 * | `GET /v1-authority-intelligence/sod-eligibility` | — | not wrapped yet |
 * | `GET /v1-authority-intelligence/blast-radius` | — | not wrapped yet |
 * | `GET /v1-authority-intelligence/explain-authority` | — | not wrapped yet |
 *
 * The three unwrapped siblings are deliberately out of scope; the namespace is
 * left open so they can be added without a breaking change.
 *
 * Note `explain-authority` IS wrapped elsewhere in this SDK — as the flat
 * `client.explainAuthority()` in `explainAuthority.ts`, landed concurrently
 * (#462). It originally called the *slash* path form
 * `/v1/authority-intelligence/explain-authority`; that 404s against the
 * real deployed edge function, which strips `/v1-authority-intelligence/`
 * as a literal prefix and only then matches sub-routes by name (confirmed
 * against atlasent-api's `v1-authority-intelligence/handler.ts` and against
 * the one proven-working caller in this ecosystem, atlasent-console's
 * sod-eligibility/blast-radius hook, which calls the hyphenated form
 * directly). Corrected to the hyphenated form to match every other route on
 * this edge function. Whether `explainAuthority` should move under this
 * namespace remains a separate, cosmetic follow-up.
 *
 * Auth: API key (`ask_live_*` / `ask_test_*`) carrying the
 * `authority_intelligence:read` scope. The organization is derived
 * **server-side** from the authenticated key — there is no client-supplied
 * `organization_id` parameter on this route.
 *
 * Usage:
 *
 * ```ts
 * import { AtlaSentClient } from "@atlasent/sdk";
 *
 * const client = new AtlaSentClient({ apiKey: "ask_live_..." });
 *
 * const report = await client.authorityIntelligence.integrityAudit();
 * for (const finding of report.findings) {
 *   console.log(finding.classification, finding.severity, finding.reason);
 * }
 * ```
 */

import { AtlaSentError } from "./errors.js";

// ── Vocabulary ────────────────────────────────────────────────────────────────

/**
 * How a finding is classified. **Three-way, and the distinction is
 * load-bearing** — this is compliance/audit evidence, not a health check:
 *
 * - `defect` — something is wrong and should be fixed.
 * - `non_exercisable` — the authority cannot be exercised. This is frequently
 *   the *correct*, healthy state, not a problem.
 * - `unresolved` — the audit could not determine which of the above applies.
 *   It must never be silently treated as clean.
 *
 * The wire enum is closed today, but the type is deliberately open (the repo's
 * `(string & Record<never, never>)` idiom, as used by `governanceGraph.ts`) so
 * a server-side fourth value neither breaks compilation nor is rejected at
 * runtime. The SDK performs no validation of this field — an unrecognized
 * value passes through verbatim as a string.
 */
export type IntegrityClassification =
  | "defect"
  | "non_exercisable"
  | "unresolved"
  | (string & Record<never, never>);

/**
 * Severity of a finding. Open for the same reason as
 * {@link IntegrityClassification} — unrecognized values pass through
 * unvalidated rather than throwing.
 */
export type IntegritySeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info"
  | (string & Record<never, never>);

/**
 * Whether the finding was directly observed in the source data or derived
 * from it. `observed` outranks `derived` as evidence.
 */
export type IntegrityEvidencePosture =
  | "observed"
  | "derived"
  | (string & Record<never, never>);

// ── Wire shape ────────────────────────────────────────────────────────────────

/**
 * A single integrity finding.
 *
 * Field names mirror the runtime wire shape verbatim (snake_case), matching
 * the convention already used by `runtime_v2.ts` and `governanceGraph.ts`.
 * Audit-evidence vocabulary is not renamed or reinterpreted client-side.
 */
export interface IntegrityFinding {
  finding_type: string;
  classification: IntegrityClassification;
  severity: IntegritySeverity;
  subject_id: string | null;
  source_table: string | null;
  source_id: string | null;
  related_source_ids: string[];
  effective_at: string | null;
  evidence_posture: IntegrityEvidencePosture;
  reason: string;
}

/**
 * The full integrity report returned by
 * `GET /v1-authority-intelligence/integrity-audit`.
 *
 * `summary` is an open-ended bag (it carries `audited_scope` — including the
 * window the server actually applied — plus counts by classification and
 * severity). Its keys are deliberately **not** enumerated as a fixed type;
 * the server may add to it. Same for `nodes` and `edges`.
 */
export interface IntegrityReport {
  schema_version: string;
  query: string;
  organization_id: string;
  evaluated_at: string;
  produced_by: string[];
  summary: Record<string, unknown>;
  findings: IntegrityFinding[];
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

// ── Query ─────────────────────────────────────────────────────────────────────

/** Query options for {@link AuthorityIntelligenceSubClient.integrityAudit}. */
export interface IntegrityAuditQuery {
  /**
   * Size of the decision window to audit, in days. Integer, 1–3650.
   *
   * Omit it and the SDK sends **no** `decision_window_days` query parameter at
   * all, letting the server apply its own default. The SDK never guesses or
   * substitutes a default of its own — the window actually applied is echoed
   * back in `report.summary.audited_scope`.
   */
  decisionWindowDays?: number;
}

// ── Convenience ───────────────────────────────────────────────────────────────

/**
 * Counts of findings per `classification`, preserving the three-way
 * distinction.
 *
 * The three known classifications are always present (`0` when none matched),
 * so a caller can read them without an existence check. Any unrecognized
 * classification the server returns appears as an additional key rather than
 * being dropped or folded into one of the three.
 */
export interface IntegrityClassificationCounts {
  defect: number;
  non_exercisable: number;
  unresolved: number;
  [classification: string]: number;
}

/**
 * Count a report's findings by `classification`.
 *
 * This is deliberately **not** a pass/fail summary. There is no `isHealthy` /
 * `hasErrors` convenience anywhere in this module, and none should be added:
 * a `non_exercisable` finding is frequently the correct, healthy state, and an
 * `unresolved` finding must never be silently treated as clean. Collapsing the
 * three-way classification to a boolean would misrepresent the evidence.
 *
 * ```ts
 * const counts = countFindingsByClassification(report);
 * if (counts.unresolved > 0) {
 *   // The audit could not resolve these — escalate, do not treat as clean.
 * }
 * ```
 */
export function countFindingsByClassification(
  report: Pick<IntegrityReport, "findings">,
): IntegrityClassificationCounts {
  const counts: IntegrityClassificationCounts = {
    defect: 0,
    non_exercisable: 0,
    unresolved: 0,
  };
  for (const finding of report.findings ?? []) {
    const key = finding.classification;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

// ── Sub-client ────────────────────────────────────────────────────────────────

/**
 * Sub-client for the `v1-authority-intelligence` read-only routes.
 * Accessed as `client.authorityIntelligence` on {@link AtlaSentClient}.
 */
export interface AuthorityIntelligenceSubClient {
  /**
   * `GET /v1-authority-intelligence/integrity-audit`
   *
   * Runs the authority integrity audit for the authenticated caller's
   * organization and returns the full report.
   *
   * The server **fails closed**: it never returns a partial or degraded
   * report. A 5xx means the audit could not complete and augmentation was
   * refused; that is propagated as an `AtlaSentError` (carrying `status` and
   * `code`) by the host client's transport, exactly like every other endpoint
   * in this SDK. Do not interpret a thrown error as "no findings".
   *
   * ```ts
   * const report = await client.authorityIntelligence.integrityAudit({
   *   decisionWindowDays: 90,
   * });
   * console.log(report.summary["audited_scope"]);
   * ```
   */
  integrityAudit(query?: IntegrityAuditQuery): Promise<IntegrityReport>;
}

/**
 * Factory that returns the authority-intelligence sub-client bound to a host
 * client's transport helpers. Called internally by AtlaSentClient.
 */
export function makeAuthorityIntelligenceClient(
  getFn: <T>(path: string, query?: URLSearchParams) => Promise<{ body: T }>,
): AuthorityIntelligenceSubClient {
  return {
    async integrityAudit(
      query: IntegrityAuditQuery = {},
    ): Promise<IntegrityReport> {
      const qs = new URLSearchParams();
      if (query.decisionWindowDays !== undefined) {
        qs.set("decision_window_days", String(query.decisionWindowDays));
      }

      const { body } = await getFn<IntegrityReport>(
        "/v1-authority-intelligence/integrity-audit",
        qs.size > 0 ? qs : undefined,
      );

      // `findings` is required by the committed wire schema. Defaulting an
      // absent/malformed array to `[]` here would manufacture a "zero
      // findings" audit out of a response the server never actually sent —
      // exactly the "a check that did not run looks like a check that
      // passed" failure this whole feature exists to prevent. A transport
      // that only checks HTTP status (a misconfigured proxy, a truncated
      // 200) must surface as an error, not a clean report.
      if (!Array.isArray(body.findings)) {
        throw new AtlaSentError(
          "Malformed response from /v1-authority-intelligence/integrity-audit: `findings` is missing or not an array",
          { code: "bad_response" },
        );
      }

      // Everything else is passed through as-is. No field is renamed,
      // coerced, or invented, and no value vocabulary is reinterpreted.
      return {
        schema_version: body.schema_version,
        query: body.query,
        organization_id: body.organization_id,
        evaluated_at: body.evaluated_at,
        produced_by: body.produced_by ?? [],
        summary: body.summary ?? {},
        findings: body.findings,
        nodes: body.nodes ?? [],
        edges: body.edges ?? [],
      };
    },
  };
}
