import { describe, expect, it, vi } from "vitest";

import {
  V2Client,
  V2Error,
  type BulkRevokeResponse,
} from "../src/index.js";

function mockFetch(status: number, body: unknown): typeof fetch {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  return vi.fn(async () =>
    new Response(json, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

const REVOKE_RESPONSE: BulkRevokeResponse = {
  revoked_count: 3,
  workflow_id: "wf-abc123",
  run_id: "run-00000000-0000-0000-0000-000000000001",
};

describe("V2Client.bulkRevoke", () => {
  it("returns a BulkRevokeResponse on success", async () => {
    const client = new V2Client({
      apiKey: "k",
      fetch: mockFetch(200, REVOKE_RESPONSE),
    });
    const out = await client.bulkRevoke({
      workflowId: "wf-abc123",
      runId: "run-00000000-0000-0000-0000-000000000001",
      reason: "emergency shutdown",
    });
    expect(out).toEqual(REVOKE_RESPONSE);
  });

  it("sends the correct body shape with snake_case keys and api_key", async () => {
    let captured: { url: string; body: Record<string, unknown> } = {
      url: "",
      body: {},
    };
    const fetchSpy: typeof fetch = vi.fn(async (url, init) => {
      captured = {
        url: String(url),
        body: JSON.parse(init?.body as string),
      };
      return new Response(JSON.stringify(REVOKE_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "ask_live_xyz", fetch: fetchSpy });
    await client.bulkRevoke({
      workflowId: "wf-abc123",
      runId: "run-uuid",
      reason: "emergency shutdown",
      revokerId: "revoker-42",
    });

    expect(captured.url).toBe("https://api.atlasent.io/v2/permits:bulk-revoke");
    expect(captured.body).toEqual({
      workflow_id: "wf-abc123",
      run_id: "run-uuid",
      reason: "emergency shutdown",
      revoker_id: "revoker-42",
      api_key: "ask_live_xyz",
    });
  });

  it("omits revoker_id from the body when not supplied", async () => {
    let body: Record<string, unknown> = {};
    const fetchSpy: typeof fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(init?.body as string);
      return new Response(JSON.stringify(REVOKE_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    await client.bulkRevoke({
      workflowId: "wf-abc123",
      runId: "run-uuid",
      reason: "scheduled teardown",
    });
    expect(body.revoker_id).toBeUndefined();
  });

  it("returns revoked_count of 0 without error (no active permits)", async () => {
    const client = new V2Client({
      apiKey: "k",
      fetch: mockFetch(200, {
        revoked_count: 0,
        workflow_id: "wf-abc123",
        run_id: "run-uuid",
      }),
    });
    const out = await client.bulkRevoke({
      workflowId: "wf-abc123",
      runId: "run-uuid",
      reason: "dry-run test",
    });
    expect(out.revoked_count).toBe(0);
  });

  it("raises V2Error on 401 with invalid_api_key code", async () => {
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(401, {}) });
    await expect(
      client.bulkRevoke({
        workflowId: "wf-abc123",
        runId: "run-uuid",
        reason: "test",
      }),
    ).rejects.toMatchObject({
      name: "V2Error",
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("raises V2Error on 500 with http_error code", async () => {
    const client = new V2Client({
      apiKey: "k",
      fetch: mockFetch(500, { error: "boom" }),
    });
    await expect(
      client.bulkRevoke({
        workflowId: "wf-abc123",
        runId: "run-uuid",
        reason: "test",
      }),
    ).rejects.toMatchObject({
      name: "V2Error",
      status: 500,
      code: "http_error",
      responseBody: { error: "boom" },
    });
  });

  it("raises V2Error on network failure", async () => {
    const fetchSpy: typeof fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    await expect(
      client.bulkRevoke({
        workflowId: "wf-abc123",
        runId: "run-uuid",
        reason: "test",
      }),
    ).rejects.toMatchObject({ code: "network" });
  });
});
