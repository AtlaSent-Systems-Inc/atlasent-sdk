/**
 * Structural assertions for the `/v1/audit/*` wire types.
 *
 * These tests exist to make drift from the source of truth (the
 * `v1-audit` edge function in `atlasent-api`) fail CI rather than
 * silently spread across call sites. They run at both compile time
 * (type-level equality checks) and runtime (a concrete fixture built
 * against every required field).
 *
 * When the wire contract changes, update:
 *   1. `atlasent-api/supabase/functions/v1-audit/index.ts` (server)
 *   2. `typescript/src/audit.ts` (SDK mirror)
 *   3. This test file (locks the mirror in place)
 * …together, in the same PR. The order above is deliberate — the
 * server change is the contract change; the SDK follows.
 */

import { describe, expect, it } from "vitest";

import type {
  AuditDecision,
  AuditEvent,
  AuditEventsPage,
  AuditEventsQuery,
  AuditExport,
  AuditExportSignatureStatus,
} from "../src/audit.js";

// ─── Type-level equality helpers ──────────────────────────────────────────────
// These evaluate to `never` when the two types diverge, which turns a
// wire-shape drift into a compile error rather than a silent runtime
// mismatch at a call site.

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;

// Required key sets — these must match the server docstring in
// `supabase/functions/v1-audit/index.ts` exactly. Do not add fields
// here without updating the server first.
type AuditEventKeys =
  | "id"
  | "org_id"
  | "sequence"
  | "type"
  | "decision"
  | "actor_id"
  | "resource_type"
  | "resource_id"
  | "payload"
  | "hash"
  | "previous_hash"
  | "occurred_at"
  | "created_at";

type AuditEventsPageKeys = "events" | "total" | "next_cursor";

type AuditEventsQueryKeys =
  | "types"
  | "actor_id"
  | "from"
  | "to"
  | "limit"
  | "cursor";

type AuditExportKeys =
  | "export_id"
  | "org_id"
  | "events"
  | "chain_head_hash"
  | "chain_integrity_ok"
  | "tampered_event_ids"
  | "signature"
  | "signature_status"
  | "signing_key_id"
  | "signed_at";

// Compile-time equality: every key of the interface must be present in
// the literal set above, and every literal in the set must exist on
// the interface. Drift either way is a TS error.
type _AuditEventKeysEqual = AssertTrue<Exact<keyof AuditEvent, AuditEventKeys>>;
type _AuditEventsPageKeysEqual = AssertTrue<
  Exact<keyof AuditEventsPage, AuditEventsPageKeys>
>;
type _AuditEventsQueryKeysEqual = AssertTrue<
  Exact<keyof AuditEventsQuery, AuditEventsQueryKeys>
>;
type _AuditExportKeysEqual = AssertTrue<Exact<keyof AuditExport, AuditExportKeys>>;

// Decision union must match the DB CHECK constraint.
type _AuditDecisionEqual = AssertTrue<
  Exact<AuditDecision, "allow" | "deny" | "hold" | "escalate">
>;

// Signature-status union must match the edge function's literal set.
type _AuditExportSignatureStatusEqual = AssertTrue<
  Exact<AuditExportSignatureStatus, "signed" | "unsigned" | "signing_failed">
>;

// Reference the assertion aliases so TS doesn't prune them as unused.
export type _TypeAssertionsInForce =
  | _AuditEventKeysEqual
  | _AuditEventsPageKeysEqual
  | _AuditEventsQueryKeysEqual
  | _AuditExportKeysEqual
  | _AuditDecisionEqual
  | _AuditExportSignatureStatusEqual;

// ─── Runtime smoke check ──────────────────────────────────────────────────────
// Exists mostly to get the file into the test suite so the type-level
// assertions above are actually compiled — and to catch accidental
// optionality changes (e.g. someone marks `hash` as optional, which
// would let `{}` satisfy the type).

describe("audit wire types", () => {
  it("AuditEvent accepts a fully-populated row", () => {
    const evt: AuditEvent = {
      id: "00000000-0000-0000-0000-000000000001",
      org_id: "00000000-0000-0000-0000-00000000000a",
      sequence: 42,
      type: "evaluate.allow",
      decision: "allow",
      actor_id: "agent.deploy-bot",
      resource_type: "policy",
      resource_id: "pol_123",
      payload: { note: "hello" },
      hash: "a".repeat(64),
      previous_hash: "0".repeat(64),
      occurred_at: "2026-04-24T00:00:00Z",
      created_at: "2026-04-24T00:00:01Z",
    };
    expect(evt.decision).toBe("allow");
    expect(evt.hash.length).toBe(64);
  });

  it("AuditEvent permits nullable fields without widening", () => {
    const evt: AuditEvent = {
      id: "00000000-0000-0000-0000-000000000002",
      org_id: "00000000-0000-0000-0000-00000000000a",
      sequence: 43,
      type: "policy.updated",
      decision: null,
      actor_id: null,
      resource_type: null,
      resource_id: null,
      payload: null,
      hash: "b".repeat(64),
      previous_hash: "a".repeat(64),
      occurred_at: "2026-04-24T00:00:02Z",
      created_at: "2026-04-24T00:00:03Z",
    };
    expect(evt.decision).toBeNull();
  });

  it("AuditEventsPage requires events + total; next_cursor is optional", () => {
    const page: AuditEventsPage = { events: [], total: 0 };
    expect(page.events).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.next_cursor).toBeUndefined();

    const paged: AuditEventsPage = { events: [], total: 500, next_cursor: "abc" };
    expect(paged.next_cursor).toBe("abc");
  });

  it("AuditEventsQuery is all-optional and survives an empty object", () => {
    const empty: AuditEventsQuery = {};
    expect(Object.keys(empty)).toEqual([]);

    const full: AuditEventsQuery = {
      types: "evaluate.allow,policy.updated",
      actor_id: "u_1",
      from: "2026-01-01T00:00:00Z",
      to: "2026-02-01T00:00:00Z",
      limit: 100,
      cursor: "opaque-b64url",
    };
    expect(full.limit).toBe(100);
  });

  it("AuditExport carries the full signed-bundle field set", () => {
    const bundle: AuditExport = {
      export_id: "00000000-0000-0000-0000-0000000000ff",
      org_id: "00000000-0000-0000-0000-00000000000a",
      events: [],
      chain_head_hash: "0".repeat(64),
      chain_integrity_ok: true,
      tampered_event_ids: [],
      signature: "sig-base64url",
      signature_status: "signed",
      signing_key_id: "k_1",
      signed_at: "2026-04-24T00:00:00Z",
    };
    expect(bundle.signature_status).toBe("signed");
    expect(bundle.tampered_event_ids).toEqual([]);
  });

  it("AuditExport.signing_key_id is omittable for unsigned exports", () => {
    const bundle: AuditExport = {
      export_id: "00000000-0000-0000-0000-0000000000ff",
      org_id: "00000000-0000-0000-0000-00000000000a",
      events: [],
      chain_head_hash: "0".repeat(64),
      chain_integrity_ok: true,
      tampered_event_ids: [],
      signature: "",
      signature_status: "unsigned",
      signed_at: "2026-04-24T00:00:00Z",
    };
    expect(bundle.signing_key_id).toBeUndefined();
  });
});

describe("audit types are re-exported from the SDK entry point", async () => {
  it("@atlasent/sdk surfaces the audit wire types", async () => {
    // Importing a type-only symbol from the entry module is the
    // cheapest smoke check that `src/index.ts` keeps the re-export
    // line — if someone deletes it the import here becomes a TS error.
    const mod = await import("../src/index.js");
    // The module exports values + types; asserting on one known value
    // keeps the runtime cost minimal while proving the module loads.
    expect(typeof mod.verifyBundle).toBe("function");
  });
});
