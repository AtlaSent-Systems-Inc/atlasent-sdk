/**
 * Usage Metering sub-client — list and summarize billable evaluation
 * records for the authenticated organization.
 *
 * Wire surface: /v1-usage-metering endpoints in atlasent-api.
 * Requires scope: `usage:read`.
 *
 * Usage:
 *
 * ```ts
 * import { AtlaSentClient } from "@atlasent/sdk";
 *
 * const client = new AtlaSentClient({ apiKey: "..." });
 *
 * // List recent evaluations
 * const { data, next_cursor } = await client.usageMetering.list({ limit: 100 });
 *
 * // Fetch a weekly summary
 * const summary = await client.usageMetering.summary({ period: "week" });
 * console.log(summary.total_evaluations, summary.billable_allows);
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Reporting period granularity for `usageMetering.summary()`. */
export type UsageMeteringPeriod = "day" | "week" | "month";

/** A single metered evaluation record. */
export interface UsageMeteringRecord {
  id: string;
  org_id: string;
  action_type: string;
  decision: "allow" | "deny" | "hold" | "escalate";
  billable: boolean;
  /** ISO-8601 timestamp when this evaluation was recorded. */
  recorded_at: string;
}

/** Paginated list of metering records from `usageMetering.list()`. */
export interface UsageMeteringListResponse {
  data: UsageMeteringRecord[];
  /** Opaque cursor — pass as `before` to fetch the next page. Absent when there are no more pages. */
  next_cursor?: string;
}

/** Aggregated usage summary for a billing period. */
export interface UsageMeteringSummary {
  org_id: string;
  /** ISO-8601 start of the reporting period (inclusive). */
  period_start: string;
  /** ISO-8601 end of the reporting period (inclusive). */
  period_end: string;
  total_evaluations: number;
  billable_allows: number;
  billable_denies: number;
}

// ── Query param types ─────────────────────────────────────────────────────────

/** Query parameters for `usageMetering.list()`. */
export interface UsageMeteringListParams {
  /** Max records to return. */
  limit?: number;
  /** Cursor from a previous page's `next_cursor`. */
  before?: string;
  /** Filter by decision value (`"allow"`, `"deny"`, `"hold"`, `"escalate"`). */
  decision?: string;
}

/** Query parameters for `usageMetering.summary()`. */
export interface UsageMeteringSummaryParams {
  /** The period granularity. Defaults to `"month"` on the server. */
  period?: UsageMeteringPeriod;
}

// ── Wire types ────────────────────────────────────────────────────────────────

interface UsageMeteringRecordWire {
  id: string;
  org_id: string;
  action_type: string;
  decision: "allow" | "deny" | "hold" | "escalate";
  billable: boolean;
  recorded_at: string;
}

interface UsageMeteringListWire {
  data: UsageMeteringRecordWire[];
  next_cursor?: string;
}

interface UsageMeteringSummaryWire {
  org_id: string;
  period_start: string;
  period_end: string;
  total_evaluations: number;
  billable_allows: number;
  billable_denies: number;
}

// ── Sub-client interface ──────────────────────────────────────────────────────

/**
 * Sub-client for usage metering data.
 * Accessed as `client.usageMetering` on {@link AtlaSentClient}.
 */
export interface UsageMeteringSubClient {
  /**
   * List metered evaluation records for the calling org, most-recent first.
   *
   * Cursor-paginated. Pass the previous response's `next_cursor` as `before`
   * to fetch the next page. Requires scope `usage:read`.
   *
   * ```ts
   * const { data, next_cursor } = await client.usageMetering.list({ limit: 50 });
   * for (const record of data) {
   *   console.log(record.action_type, record.decision, record.billable);
   * }
   * ```
   */
  list(params?: UsageMeteringListParams): Promise<UsageMeteringListResponse>;

  /**
   * Fetch an aggregated usage summary for a billing period.
   *
   * Returns totals for the current calendar period (`day`, `week`, or
   * `month`). Requires scope `usage:read`.
   *
   * ```ts
   * const summary = await client.usageMetering.summary({ period: "month" });
   * console.log(`${summary.total_evaluations} evaluations this month`);
   * ```
   */
  summary(params?: UsageMeteringSummaryParams): Promise<UsageMeteringSummary>;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Factory that returns the usage-metering sub-client bound to a host client's
 * transport helpers. Called internally by AtlaSentClient; not part of the
 * public constructor API.
 */
export function makeUsageMeteringClient(
  getFn: <T>(path: string, query?: URLSearchParams) => Promise<{ body: T }>,
): UsageMeteringSubClient {
  return {
    async list(
      params: UsageMeteringListParams = {},
    ): Promise<UsageMeteringListResponse> {
      const qs = new URLSearchParams();
      if (params.limit !== undefined) qs.set("limit", String(params.limit));
      if (params.before) qs.set("before", params.before);
      if (params.decision) qs.set("decision", params.decision);

      const { body } = await getFn<UsageMeteringListWire>(
        "/v1-usage-metering",
        qs.size > 0 ? qs : undefined,
      );

      const result: UsageMeteringListResponse = {
        data: (body.data ?? []).map((r: UsageMeteringRecordWire) => ({
          id: r.id,
          org_id: r.org_id,
          action_type: r.action_type,
          decision: r.decision,
          billable: r.billable,
          recorded_at: r.recorded_at,
        })),
      };
      if (body.next_cursor !== undefined) {
        result.next_cursor = body.next_cursor;
      }
      return result;
    },

    async summary(
      params: UsageMeteringSummaryParams = {},
    ): Promise<UsageMeteringSummary> {
      const qs = new URLSearchParams();
      if (params.period) qs.set("period", params.period);

      const { body } = await getFn<UsageMeteringSummaryWire>(
        "/v1-usage-metering/summary",
        qs.size > 0 ? qs : undefined,
      );

      return {
        org_id: body.org_id,
        period_start: body.period_start,
        period_end: body.period_end,
        total_evaluations: body.total_evaluations,
        billable_allows: body.billable_allows,
        billable_denies: body.billable_denies,
      };
    },
  };
}
