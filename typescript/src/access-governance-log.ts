/**
 * Access Governance Log sub-client — paginated identity lifecycle events.
 *
 * Wire surface: GET /v1/access-governance-log
 *
 * Usage:
 *
 * ```ts
 * import { AtlaSentClient } from "@atlasent/sdk";
 *
 * const client = new AtlaSentClient({ apiKey: "..." });
 *
 * const page = await client.accessGovernanceLog.list({ limit: 50 });
 * for (const event of page.events) {
 *   console.log(event.eventType, event.actorEmail);
 * }
 * if (page.nextCursor) {
 *   const next = await client.accessGovernanceLog.list({ cursor: page.nextCursor });
 * }
 * ```
 */

// ── Wire shape ────────────────────────────────────────────────────────────────

interface AccessGovernanceEventWire {
  id: string;
  event_type: string;
  org_id: string;
  actor_id: string | null;
  actor_email: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface AccessGovernanceLogResponseWire {
  events: AccessGovernanceEventWire[];
  next_cursor: string | null;
  total_count: number;
}

// ── SDK shape ─────────────────────────────────────────────────────────────────

/** A single identity lifecycle event from the access governance log. */
export interface AccessGovernanceEvent {
  id: string;
  eventType: string;
  orgId: string;
  actorId: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** A page of access governance events with cursor for the next page. */
export interface AccessGovernanceLogPage {
  events: AccessGovernanceEvent[];
  /** Pass as `cursor` to `list()` to fetch the next page. `null` means no more pages. */
  nextCursor: string | null;
  totalCount: number;
}

/** Query parameters for `accessGovernanceLog.list()`. */
export interface AccessGovernanceLogQuery {
  /** Max events to return. Default 50, max 200. */
  limit?: number;
  /** Cursor from a previous page's `nextCursor`. */
  cursor?: string;
  /** Filter by event type (e.g. `"sso.login"`, `"jit.provisioned"`). */
  eventType?: string;
  /** Filter by actor email or UUID. */
  actorId?: string;
  /** Lower bound on event timestamp (ISO 8601). */
  from?: string;
  /** Upper bound on event timestamp (ISO 8601). */
  to?: string;
}

// ── Converter ─────────────────────────────────────────────────────────────────

function wireToEvent(w: AccessGovernanceEventWire): AccessGovernanceEvent {
  return {
    id: w.id,
    eventType: w.event_type,
    orgId: w.org_id,
    actorId: w.actor_id,
    actorEmail: w.actor_email,
    ipAddress: w.ip_address,
    metadata: w.metadata ?? {},
    createdAt: w.created_at,
  };
}

// ── Sub-client ────────────────────────────────────────────────────────────────

/**
 * Sub-client for the access governance log.
 * Accessed as `client.accessGovernanceLog` on {@link AtlaSentClient}.
 */
export interface AccessGovernanceLogSubClient {
  /**
   * Fetch a page of identity lifecycle events for the authenticated org.
   *
   * ```ts
   * const { events, nextCursor } = await client.accessGovernanceLog.list({
   *   eventType: "sso.login",
   *   limit: 100,
   * });
   * ```
   */
  list(query?: AccessGovernanceLogQuery): Promise<AccessGovernanceLogPage>;
}

/**
 * Factory that returns the access-governance-log sub-client bound to a host
 * client's transport helpers. Called internally by AtlaSentClient.
 */
export function makeAccessGovernanceLogClient(
  getFn: <T>(path: string, query?: URLSearchParams) => Promise<{ body: T }>,
): AccessGovernanceLogSubClient {
  return {
    async list(query: AccessGovernanceLogQuery = {}): Promise<AccessGovernanceLogPage> {
      const qs = new URLSearchParams();
      if (query.limit !== undefined) qs.set("limit", String(query.limit));
      if (query.cursor)    qs.set("cursor", query.cursor);
      if (query.eventType) qs.set("event_type", query.eventType);
      if (query.actorId)   qs.set("actor_id", query.actorId);
      if (query.from)      qs.set("from", query.from);
      if (query.to)        qs.set("to", query.to);

      const { body } = await getFn<AccessGovernanceLogResponseWire>(
        "/v1/access-governance-log",
        qs.size > 0 ? qs : undefined,
      );

      return {
        events: (body.events ?? []).map(wireToEvent),
        nextCursor: body.next_cursor,
        totalCount: body.total_count ?? 0,
      };
    },
  };
}
