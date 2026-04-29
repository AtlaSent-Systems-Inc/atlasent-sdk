import { describe, expect, it, vi } from "vitest";

import {
  V2Client,
  V2Error,
  type BatchEvaluateItem,
  type EvaluateBatchResponse,
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

const SAMPLE_ITEM: BatchEvaluateItem = {
  action: "deploy",
  agent: "deploy-bot",
  context: { commit: "abc" },
};

describe("V2Client.evaluateBatch", () => {
  it("returns an EvaluateBatchResponse on success", async () => {
    const expected: EvaluateBatchResponse = {
      batch_id: "33333333-3333-3333-3333-333333333333",
      items: [
        {
          index: 0,
          permitted: true,
          decision_id: "dec_1",
          reason: "OK",
          audit_hash: "a".repeat(64),
          timestamp: "2026-04-27T16:00:00Z",
          batch_id: "33333333-3333-3333-3333-333333333333",
        },
      ],
    };
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(200, expected) });
    const out = await client.evaluateBatch([SAMPLE_ITEM]);
    expect(out).toEqual(expected);
    expect(out.items[0]?.permitted).toBe(true);
  });

  it("posts to /v2/evaluate:batch with requests + api_key", async () => {
    let captured: { url: string; body: Record<string, unknown> } = {
      url: "",
      body: {},
    };
    const fetchSpy: typeof fetch = vi.fn(async (url, init) => {
      captured = {
        url: String(url),
        body: JSON.parse(init?.body as string),
      };
      return new Response(
        JSON.stringify({ batch_id: "b", items: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "ask_xyz", fetch: fetchSpy });
    await client.evaluateBatch([SAMPLE_ITEM, { ...SAMPLE_ITEM, agent: "other" }]);

    expect(captured.url).toBe("https://api.atlasent.io/v2/evaluate:batch");
    expect(captured.body).toEqual({
      requests: [SAMPLE_ITEM, { ...SAMPLE_ITEM, agent: "other" }],
      api_key: "ask_xyz",
    });
  });

  it("preserves order — items[i] matches requests[i]", async () => {
    const items: BatchEvaluateItem[] = [
      { action: "a", agent: "1", context: {} },
      { action: "b", agent: "2", context: {} },
      { action: "c", agent: "3", context: {} },
    ];
    const response: EvaluateBatchResponse = {
      batch_id: "b",
      items: items.map((_, i) => ({
        index: i,
        permitted: true,
        decision_id: `dec_${i}`,
        reason: "",
        audit_hash: "a".repeat(64),
        timestamp: "2026-04-27T16:00:00Z",
        batch_id: "b",
      })),
    };
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(200, response) });
    const out = await client.evaluateBatch(items);
    expect(out.items.map((i) => i.decision_id)).toEqual(["dec_0", "dec_1", "dec_2"]);
    expect(out.items.map((i) => i.index)).toEqual([0, 1, 2]);
  });

  it("supports payload_hash + target on Pillar 9 opt-in items", async () => {
    let body: Record<string, unknown> = {};
    const fetchSpy: typeof fetch = vi.fn(async (_url, init) => {
      body = JSON.parse(init?.body as string);
      return new Response(
        JSON.stringify({ batch_id: "b", items: [] }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const item: BatchEvaluateItem = {
      ...SAMPLE_ITEM,
      payload_hash: "f".repeat(64),
      target: "prod-cluster",
    };
    await client.evaluateBatch([item]);
    expect((body.requests as BatchEvaluateItem[])[0]?.payload_hash).toBe("f".repeat(64));
    expect((body.requests as BatchEvaluateItem[])[0]?.target).toBe("prod-cluster");
  });

  it("surfaces denial items with permitted=false", async () => {
    const response: EvaluateBatchResponse = {
      batch_id: "b",
      items: [
        {
          index: 0,
          permitted: false,
          decision_id: "dec_denied",
          reason: "Missing approver",
          audit_hash: "a".repeat(64),
          timestamp: "2026-04-27T16:00:00Z",
          batch_id: "b",
        },
      ],
    };
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(200, response) });
    const out = await client.evaluateBatch([SAMPLE_ITEM]);
    expect(out.items[0]?.permitted).toBe(false);
    expect(out.items[0]?.reason).toBe("Missing approver");
  });

  it("rejects empty requests array before sending", async () => {
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    await expect(client.evaluateBatch([])).rejects.toMatchObject({
      name: "V2Error",
      code: "invalid_argument",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects non-array input before sending", async () => {
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    // @ts-expect-error — runtime guard
    await expect(client.evaluateBatch(undefined)).rejects.toThrow(V2Error);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejects requests over the 1000-item cap before sending", async () => {
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    const client = new V2Client({ apiKey: "k", fetch: fetchSpy });
    const tooMany: BatchEvaluateItem[] = Array.from({ length: 1001 }, () => SAMPLE_ITEM);
    await expect(client.evaluateBatch(tooMany)).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts exactly 1000 items (the cap)", async () => {
    const response: EvaluateBatchResponse = { batch_id: "b", items: [] };
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(200, response) });
    const cap: BatchEvaluateItem[] = Array.from({ length: 1000 }, () => SAMPLE_ITEM);
    await expect(client.evaluateBatch(cap)).resolves.toEqual(response);
  });

  it("raises V2Error on 401", async () => {
    const client = new V2Client({ apiKey: "k", fetch: mockFetch(401, {}) });
    await expect(client.evaluateBatch([SAMPLE_ITEM])).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
    });
  });

  it("raises V2Error on 500", async () => {
    const client = new V2Client({
      apiKey: "k",
      fetch: mockFetch(500, { error: "boom" }),
    });
    await expect(client.evaluateBatch([SAMPLE_ITEM])).rejects.toMatchObject({
      status: 500,
      code: "http_error",
    });
  });
});
