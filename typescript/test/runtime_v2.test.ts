/**
 * Tests for runtime_v2 — RuntimeV2Client four-plane lifecycle.
 */

import { describe, expect, it } from "vitest";
import { RuntimeV2Client } from "../src/runtime_v2.js";
import type { V2Transport } from "../src/v2.js";

const BASE_URL = "https://api.atlasent.io";
const API_KEY = "ask_test_rv2";
const ORG = "org_acme";
const PERMIT_ID = "permit-uuid-1234";
const EVIDENCE_ID = "evidence-uuid-5678";
const AUTHORITY_ID = "did:key:z6Mk";

function transport(mockFetch: typeof fetch): V2Transport {
  return { baseUrl: BASE_URL, apiKey: API_KEY, fetch: mockFetch };
}

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── authorize ─────────────────────────────────────────────────────────────────

describe("authorize", () => {
  it("returns PERMITTED with permit", async () => {
    const permit = { permit_id: PERMIT_ID, status: "ACTIVE" };
    const f = async () => jsonResp({ status: "PERMITTED", permit });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.authorize(ORG, { transition: { from: "idle", to: "running" } });
    expect(result.status).toBe("PERMITTED");
    expect(result.permit).toEqual(permit);
  });

  it("returns DENIED with reasons", async () => {
    const f = async () =>
      jsonResp({ status: "DENIED", reasons: ["policy X denied"], policy_ids: ["pol_abc"] });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.authorize(ORG, {});
    expect(result.status).toBe("DENIED");
    expect(result.reasons).toContain("policy X denied");
    expect(result.permit).toBeUndefined();
  });

  it("returns PENDING_APPROVAL with required_approvers", async () => {
    const f = async () =>
      jsonResp({
        status: "PENDING_APPROVAL",
        permit: { permit_id: PERMIT_ID },
        required_approvers: ["did:key:approver1"],
      });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.authorize(ORG, {});
    expect(result.status).toBe("PENDING_APPROVAL");
    expect(result.required_approvers).toContain("did:key:approver1");
  });

  it("calls POST /v2/orgs/:orgId/transitions", async () => {
    let calledUrl = "";
    const f = async (url: string | Request | URL) => {
      calledUrl = url.toString();
      return jsonResp({ status: "PERMITTED", permit: {} });
    };
    const rt = new RuntimeV2Client(transport(f as typeof fetch));
    await rt.authorize(ORG, {});
    expect(calledUrl).toBe(`${BASE_URL}/v2/orgs/${ORG}/transitions`);
  });
});

// ── getPermit ─────────────────────────────────────────────────────────────────

describe("getPermit", () => {
  it("returns permit when found", async () => {
    const permit = { permit_id: PERMIT_ID };
    const f = async () => jsonResp({ permit });
    const rt = new RuntimeV2Client(transport(f));
    expect(await rt.getPermit(ORG, PERMIT_ID)).toEqual(permit);
  });

  it("returns null when not in response", async () => {
    const f = async () => jsonResp({ permit: null });
    const rt = new RuntimeV2Client(transport(f));
    expect(await rt.getPermit(ORG, PERMIT_ID)).toBeNull();
  });
});

// ── consume ───────────────────────────────────────────────────────────────────

describe("consume", () => {
  it("returns passed=true on success", async () => {
    const f = async () =>
      jsonResp({ passed: true, verified_at: "2026-05-30T07:00:00Z", failures: [], warnings: [] });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.consume(ORG, PERMIT_ID, "sha256:abc");
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it("returns passed=false with failures", async () => {
    const f = async () =>
      jsonResp({
        passed: false,
        verified_at: "2026-05-30T07:00:00Z",
        failures: [{ code: "SOURCE_STATE_MISMATCH", message: "mismatch" }],
        warnings: [],
      });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.consume(ORG, PERMIT_ID, "sha256:wrong");
    expect(result.passed).toBe(false);
    expect(result.failures[0]?.code).toBe("SOURCE_STATE_MISMATCH");
  });
});

// ── approve ───────────────────────────────────────────────────────────────────

describe("approve", () => {
  it("returns approved=true and status", async () => {
    const f = async () => jsonResp({ approved: true, status: "ACTIVE" });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.approve(ORG, PERMIT_ID, "did:key:z6Mk", "sig_abc");
    expect(result.approved).toBe(true);
    expect(result.status).toBe("ACTIVE");
  });
});

// ── complete ──────────────────────────────────────────────────────────────────

describe("complete", () => {
  it("returns verified=true with receipt", async () => {
    const receipt = {
      receipt_id: "rcpt-1",
      permit_id: PERMIT_ID,
      org_id: ORG,
      issued_at: "2026-05-30T07:00:00Z",
      post_state_fingerprint: "sha256:post",
      evidence_id: EVIDENCE_ID,
    };
    const f = async () =>
      jsonResp({ verified: true, evidence_completeness: "COMPLETE", failures: [], receipt });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.complete(ORG, PERMIT_ID, EVIDENCE_ID, "sha256:post");
    expect(result.verified).toBe(true);
    expect(result.evidence_completeness).toBe("COMPLETE");
    expect(result.receipt?.receipt_id).toBe("rcpt-1");
  });

  it("returns verified=false without receipt", async () => {
    const f = async () =>
      jsonResp({
        verified: false,
        evidence_completeness: "FAILED",
        failures: [{ code: "EVIDENCE_INCOMPLETE", message: "missing" }],
      });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.complete(ORG, PERMIT_ID, EVIDENCE_ID, "sha256:post");
    expect(result.verified).toBe(false);
    expect(result.receipt).toBeUndefined();
    expect(result.failures[0]?.code).toBe("EVIDENCE_INCOMPLETE");
  });
});

// ── authorities ───────────────────────────────────────────────────────────────

describe("listAuthorities", () => {
  it("returns authority list", async () => {
    const auth = { authority_id: AUTHORITY_ID, org_id: ORG, name: "Root", action_classes: ["DEPLOY"], public_key: "pk", key_id: "kid", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z" };
    const f = async () => jsonResp({ authorities: [auth] });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.listAuthorities(ORG);
    expect(result).toHaveLength(1);
    expect(result[0]?.authority_id).toBe(AUTHORITY_ID);
  });
});

describe("getAuthority", () => {
  it("returns authority when found", async () => {
    const auth = { authority_id: AUTHORITY_ID, org_id: ORG, name: "Root", action_classes: [], public_key: "pk", key_id: "kid", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z" };
    const f = async () => jsonResp({ authority: auth });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.getAuthority(ORG, AUTHORITY_ID);
    expect(result?.authority_id).toBe(AUTHORITY_ID);
  });

  it("returns null when not found", async () => {
    const f = async () => jsonResp({ authority: null });
    const rt = new RuntimeV2Client(transport(f));
    expect(await rt.getAuthority(ORG, AUTHORITY_ID)).toBeNull();
  });
});

// ── evidence & audit ──────────────────────────────────────────────────────────

describe("getEvidence", () => {
  it("returns evidence package", async () => {
    const pkg = { evidence_id: EVIDENCE_ID, permit_id: PERMIT_ID };
    const f = async () => jsonResp({ evidence: pkg });
    const rt = new RuntimeV2Client(transport(f));
    expect(await rt.getEvidence(ORG, EVIDENCE_ID)).toEqual(pkg);
  });
});

describe("queryAuditChain", () => {
  it("returns paginated entries", async () => {
    const entry = { entry_id: "e1", org_id: ORG, sequence: 1, receipt_id: "rcpt-1", prior_hash: "0".repeat(64), entry_hash: "a".repeat(64), appended_at: "2026-05-30T07:00:00Z" };
    const f = async () => jsonResp({ entries: [entry], total: 1, page: 1, page_size: 100 });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.queryAuditChain(ORG, "2026-05-01T00:00:00Z", "2026-05-31T00:00:00Z");
    expect(result.total).toBe(1);
    expect(result.entries[0]?.sequence).toBe(1);
  });
});

describe("verifyChainIntegrity", () => {
  it("returns valid report", async () => {
    const f = async () =>
      jsonResp({ valid: true, checked_entries: 10, first_sequence: 1, last_sequence: 10, gaps: [], invalid_hashes: [], verified_at: "2026-05-30T07:00:00Z" });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.verifyChainIntegrity(ORG, 1, 10);
    expect(result.valid).toBe(true);
    expect(result.checked_entries).toBe(10);
    expect(result.gaps).toHaveLength(0);
  });
});

describe("exportCompliance", () => {
  it("returns compliance export", async () => {
    const f = async () =>
      jsonResp({ export_id: "exp-1", org_id: ORG, from: "2026-05-01T00:00:00Z", to: "2026-05-31T00:00:00Z", entry_count: 42, format: "JSON", content_ref: "s3://bucket/x.json", content_hash: "sha256:abc", generated_at: "2026-05-30T07:00:00Z", signed_by: "did:key:root" });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.exportCompliance(ORG, "2026-05-01T00:00:00Z", "2026-05-31T00:00:00Z");
    expect(result.entry_count).toBe(42);
    expect(result.format).toBe("JSON");
    expect(result.export_id).toBe("exp-1");
  });
});

// ── revokePermit ─────────────────────────────────────────────────────────────

describe("revokePermit", () => {
  it("sends DELETE with revocation body", async () => {
    let method = "";
    let body = "";
    const f = async (_url: string | Request | URL, init?: RequestInit) => {
      method = (init?.method as string) ?? "";
      body = (init?.body as string) ?? "";
      return new Response(null, { status: 200 });
    };
    const rt = new RuntimeV2Client(transport(f as typeof fetch));
    await rt.revokePermit(ORG, PERMIT_ID, "did:key:revoker", "expired");
    expect(method).toBe("DELETE");
    expect(JSON.parse(body)).toMatchObject({ revoked_by: "did:key:revoker", reason: "expired" });
  });

  it("propagates_to_children flag is forwarded", async () => {
    let body = "";
    const f = async (_url: string | Request | URL, init?: RequestInit) => {
      body = (init?.body as string) ?? "";
      return new Response(null, { status: 200 });
    };
    const rt = new RuntimeV2Client(transport(f as typeof fetch));
    await rt.revokePermit(ORG, PERMIT_ID, "did:key:r", "reason", true);
    expect(JSON.parse(body).propagates_to_children).toBe(true);
  });
});

// ── createAuthority / rotateAuthority / revokeAuthority ───────────────────────

describe("createAuthority", () => {
  it("returns created authority", async () => {
    const auth = { authority_id: AUTHORITY_ID, org_id: ORG, name: "New", action_classes: ["DEPLOY"], public_key: "pk", key_id: "kid", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z" };
    const f = async () => jsonResp({ authority: auth });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.createAuthority(ORG, { name: "New" });
    expect(result.authority_id).toBe(AUTHORITY_ID);
  });
});

describe("rotateAuthority", () => {
  it("returns updated authority with new key", async () => {
    const auth = { authority_id: AUTHORITY_ID, org_id: ORG, name: "Root", action_classes: [], public_key: "new_pk", key_id: "new_kid", status: "ACTIVE", created_at: "2026-01-01T00:00:00Z" };
    const f = async () => jsonResp({ authority: auth });
    const rt = new RuntimeV2Client(transport(f));
    const result = await rt.rotateAuthority(ORG, AUTHORITY_ID, "new_pk", "new_kid");
    expect(result.public_key).toBe("new_pk");
  });
});

describe("revokeAuthority", () => {
  it("resolves without throwing", async () => {
    const f = async () => jsonResp({});
    const rt = new RuntimeV2Client(transport(f));
    await expect(rt.revokeAuthority(ORG, AUTHORITY_ID, "compromised")).resolves.toBeUndefined();
  });
});

// ── submitEvidence ────────────────────────────────────────────────────────────

describe("submitEvidence", () => {
  it("resolves without throwing", async () => {
    const f = async () => jsonResp({}, 201);
    const rt = new RuntimeV2Client(transport(f));
    await expect(rt.submitEvidence(ORG, { evidence_id: EVIDENCE_ID })).resolves.toBeUndefined();
  });
});

// ── queryAuditChain with filters ──────────────────────────────────────────────

describe("queryAuditChain with filters", () => {
  it("includes filter params in request URL", async () => {
    let calledUrl = "";
    const f = async (url: string | Request | URL) => {
      calledUrl = url.toString();
      return jsonResp({ entries: [], total: 0, page: 1, page_size: 50 });
    };
    const rt = new RuntimeV2Client(transport(f as typeof fetch));
    await rt.queryAuditChain(ORG, "2026-05-01T00:00:00Z", "2026-05-31T00:00:00Z", {
      page: 1, page_size: 50, action_class: "DEPLOY",
    });
    expect(calledUrl).toContain("action_class=DEPLOY");
    expect(calledUrl).toContain("page_size=50");
  });
});

// ── error handling ────────────────────────────────────────────────────────────

describe("error handling", () => {
  it("throws AtlaSentError on 4xx POST", async () => {
    const f = async () =>
      jsonResp({ error: { code: "not_found", message: "permit not found" } }, 404);
    const rt = new RuntimeV2Client(transport(f));
    await expect(rt.consume(ORG, "bad-id", "fp")).rejects.toThrow("permit not found");
  });

  it("throws AtlaSentError on 4xx GET", async () => {
    const f = async () =>
      jsonResp({ error: { code: "not_found", message: "authority not found" } }, 404);
    const rt = new RuntimeV2Client(transport(f));
    await expect(rt.getAuthority(ORG, "bad-id")).rejects.toThrow("authority not found");
  });

  it("throws AtlaSentError with generic message when DELETE returns non-JSON body", async () => {
    const f = async () =>
      new Response("Internal Server Error", {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      });
    const rt = new RuntimeV2Client(transport(f));
    await expect(
      rt.revokePermit(ORG, PERMIT_ID, "admin", "circuit-breaker"),
    ).rejects.toThrow(`DELETE /v2/orgs/${ORG}/permits/${PERMIT_ID} failed (503)`);
  });

  it("uses globalThis.fetch when transport.fetch is not set", async () => {
    const saved = (globalThis as Record<string, unknown>).fetch;
    (globalThis as Record<string, unknown>).fetch = async () =>
      jsonResp({ status: "PERMITTED", permit: { permit_id: PERMIT_ID } });
    try {
      const rt = new RuntimeV2Client({ baseUrl: BASE_URL, apiKey: API_KEY });
      const r = await rt.authorize(ORG, { action_type: "test.action", actor_id: "a" });
      expect(r.status).toBe("PERMITTED");
    } finally {
      (globalThis as Record<string, unknown>).fetch = saved;
    }
  });
});
