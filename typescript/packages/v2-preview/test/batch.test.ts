/**
 * Tests for the Pillar 2 batch builders.
 *
 * Covers:
 *   - buildEvaluateBatchRequest validates size + per-item shape
 *   - Optional fields (payload_hash, target) round-trip
 *   - Forward-compat extra fields pass through
 *   - parseEvaluateBatchResponse narrows the per-item discriminated union
 *   - Allow vs. deny items distinguish correctly
 *   - Pillar 9 opt-in fields (proof_id, proof_status) survive parsing
 *   - Schema parity assertions against `contract/schemas/v2/`
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type {
  BatchEvaluateAllowItem,
  BatchEvaluateDenyItem,
  BatchEvaluateItem,
  EvaluateBatchResponse,
} from "../src/batch.js";
import {
  buildEvaluateBatchRequest,
  parseEvaluateBatchResponse,
} from "../src/buildBatch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "contract",
  "schemas",
  "v2",
);

function loadSchema(file: string): {
  required: string[];
  properties: Record<string, unknown>;
  $defs?: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
} {
  const raw = readFileSync(resolve(SCHEMAS_DIR, file), "utf8");
  return JSON.parse(raw);
}

const SAMPLE_ITEM: BatchEvaluateItem = {
  action: "modify_record",
  agent: "agent-1",
  context: { id: "PT-001" },
};

describe("buildEvaluateBatchRequest", () => {
  it("returns a wire-shaped object with the api_key echoed", () => {
    const req = buildEvaluateBatchRequest([SAMPLE_ITEM], "ask_live_test");
    expect(req).toEqual({
      requests: [
        {
          action: "modify_record",
          agent: "agent-1",
          context: { id: "PT-001" },
        },
      ],
      api_key: "ask_live_test",
    });
  });

  it("preserves payload_hash and target when set on an item", () => {
    const item: BatchEvaluateItem = {
      ...SAMPLE_ITEM,
      payload_hash: "a".repeat(64),
      target: "prod-cluster",
    };
    const req = buildEvaluateBatchRequest([item], "ask_live_test");
    expect(req.requests[0]).toMatchObject({
      payload_hash: "a".repeat(64),
      target: "prod-cluster",
    });
  });

  it("forwards forward-compat extra fields untouched", () => {
    const item = {
      ...SAMPLE_ITEM,
      future_field_v3: "preserved",
    } as BatchEvaluateItem;
    const req = buildEvaluateBatchRequest([item], "ask_live_test");
    const out = req.requests[0] as unknown as Record<string, unknown>;
    expect(out.future_field_v3).toBe("preserved");
  });

  it("rejects an empty items array", () => {
    expect(() => buildEvaluateBatchRequest([], "ask_live_test")).toThrow(
      /at least 1 item/i,
    );
  });

  it("rejects more than 1000 items", () => {
    const items = Array.from({ length: 1001 }, () => ({ ...SAMPLE_ITEM }));
    expect(() => buildEvaluateBatchRequest(items, "ask_live_test")).toThrow(
      /exceeds max 1000/i,
    );
  });

  it("accepts exactly 1000 items (boundary)", () => {
    const items = Array.from({ length: 1000 }, () => ({ ...SAMPLE_ITEM }));
    const req = buildEvaluateBatchRequest(items, "ask_live_test");
    expect(req.requests).toHaveLength(1000);
  });

  it("rejects an empty api_key", () => {
    expect(() => buildEvaluateBatchRequest([SAMPLE_ITEM], "")).toThrow(
      /api_key/i,
    );
  });

  it("rejects a non-string api_key", () => {
    expect(() =>
      buildEvaluateBatchRequest([SAMPLE_ITEM], null as unknown as string),
    ).toThrow(/api_key/i);
  });

  it("rejects items with empty action", () => {
    expect(() =>
      buildEvaluateBatchRequest(
        [{ ...SAMPLE_ITEM, action: "" }],
        "ask_live_test",
      ),
    ).toThrow(/items\[0\]\.action/i);
  });

  it("rejects items with empty agent", () => {
    expect(() =>
      buildEvaluateBatchRequest(
        [{ ...SAMPLE_ITEM, agent: "" }],
        "ask_live_test",
      ),
    ).toThrow(/items\[0\]\.agent/i);
  });

  it("rejects items with malformed payload_hash (not 64 hex)", () => {
    expect(() =>
      buildEvaluateBatchRequest(
        [{ ...SAMPLE_ITEM, payload_hash: "not-hex" }],
        "ask_live_test",
      ),
    ).toThrow(/payload_hash/i);
  });

  it("rejects items with payload_hash uppercase hex (must be lowercase)", () => {
    expect(() =>
      buildEvaluateBatchRequest(
        [{ ...SAMPLE_ITEM, payload_hash: "A".repeat(64) }],
        "ask_live_test",
      ),
    ).toThrow(/payload_hash/i);
  });

  it("defaults context to {} when omitted", () => {
    const item = {
      action: "x",
      agent: "y",
    } as unknown as BatchEvaluateItem;
    const req = buildEvaluateBatchRequest([item], "ask_live_test");
    expect(req.requests[0]?.context).toEqual({});
  });
});

describe("parseEvaluateBatchResponse", () => {
  const SAMPLE_BODY = {
    batch_id: "550e8400-e29b-41d4-a716-446655440000",
    items: [
      {
        index: 0,
        permitted: true,
        decision_id: "dec_alpha",
        reason: "ok",
        audit_hash: "a".repeat(64),
        timestamp: "2026-04-25T00:00:00Z",
        batch_id: "550e8400-e29b-41d4-a716-446655440000",
      },
      {
        index: 1,
        permitted: false,
        decision_id: "dec_beta",
        reason: "missing change_reason",
        audit_hash: "b".repeat(64),
        timestamp: "2026-04-25T00:00:01Z",
        batch_id: "550e8400-e29b-41d4-a716-446655440000",
      },
    ],
  };

  it("parses a well-formed response", () => {
    const parsed = parseEvaluateBatchResponse(SAMPLE_BODY);
    expect(parsed.batch_id).toBe(SAMPLE_BODY.batch_id);
    expect(parsed.items).toHaveLength(2);
  });

  it("narrows allow vs. deny via the `permitted` discriminator", () => {
    const parsed = parseEvaluateBatchResponse(SAMPLE_BODY);
    const allowItem = parsed.items[0]!;
    if (!allowItem.permitted) throw new Error("expected allow");
    // Compile-time: type narrowed to BatchEvaluateAllowItem.
    const allow: BatchEvaluateAllowItem = allowItem;
    expect(allow.decision_id).toBe("dec_alpha");

    const denyItem = parsed.items[1]!;
    if (denyItem.permitted) throw new Error("expected deny");
    const deny: BatchEvaluateDenyItem = denyItem;
    expect(deny.reason).toBe("missing change_reason");
  });

  it("preserves Pillar 9 proof fields when the server emits them", () => {
    const body = {
      batch_id: "b1",
      items: [
        {
          index: 0,
          permitted: true,
          decision_id: "d1",
          reason: "",
          audit_hash: "a".repeat(64),
          timestamp: "t",
          batch_id: "b1",
          proof_id: "550e8400-e29b-41d4-a716-446655440000",
          proof_status: "pending",
        },
      ],
    };
    const parsed = parseEvaluateBatchResponse(body);
    const item = parsed.items[0]!;
    expect(item.proof_id).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(item.proof_status).toBe("pending");
  });

  it("preserves forward-compat extra fields on items", () => {
    const body = {
      batch_id: "b1",
      items: [
        {
          ...SAMPLE_BODY.items[0],
          future_item_field_v3: 42,
        },
      ],
    };
    const parsed = parseEvaluateBatchResponse(body) as EvaluateBatchResponse & {
      items: Array<Record<string, unknown>>;
    };
    expect(parsed.items[0]!.future_item_field_v3).toBe(42);
  });

  it("rejects a non-object body", () => {
    expect(() => parseEvaluateBatchResponse([])).toThrow(/JSON object/i);
    expect(() => parseEvaluateBatchResponse(null)).toThrow(/JSON object/i);
    expect(() => parseEvaluateBatchResponse("string")).toThrow(/JSON object/i);
  });

  it("rejects a missing batch_id", () => {
    expect(() => parseEvaluateBatchResponse({ items: [] })).toThrow(
      /batch_id/i,
    );
  });

  it("rejects an empty-string batch_id", () => {
    expect(() =>
      parseEvaluateBatchResponse({ batch_id: "", items: [] }),
    ).toThrow(/batch_id/i);
  });

  it("rejects items not being an array", () => {
    expect(() =>
      parseEvaluateBatchResponse({ batch_id: "b1", items: "nope" }),
    ).toThrow(/items.*array/i);
  });

  it("rejects items[i] not being an object", () => {
    expect(() =>
      parseEvaluateBatchResponse({ batch_id: "b1", items: ["string"] }),
    ).toThrow(/items\[0\].*JSON object/i);
  });

  it("rejects items[i].permitted not being a boolean", () => {
    expect(() =>
      parseEvaluateBatchResponse({
        batch_id: "b1",
        items: [{ ...SAMPLE_BODY.items[0], permitted: "true" }],
      }),
    ).toThrow(/items\[0\]\.permitted/i);
  });

  it("rejects items[i].decision_id not being a string", () => {
    expect(() =>
      parseEvaluateBatchResponse({
        batch_id: "b1",
        items: [{ ...SAMPLE_BODY.items[0], decision_id: 42 }],
      }),
    ).toThrow(/items\[0\]\.decision_id/i);
  });

  it("accepts an empty items array (server-emitted edge case)", () => {
    const parsed = parseEvaluateBatchResponse({ batch_id: "b1", items: [] });
    expect(parsed.items).toEqual([]);
  });
});

describe("schema parity", () => {
  it("EvaluateBatchRequest required fields match the schema", () => {
    const schema = loadSchema("evaluate-batch-request.schema.json");
    const required = new Set(schema.required);
    const built = buildEvaluateBatchRequest([SAMPLE_ITEM], "ask_live_test");
    for (const field of required) {
      expect(Object.keys(built)).toContain(field);
    }
  });

  it("BatchEvaluateItem required fields match the schema's $defs entry", () => {
    const schema = loadSchema("evaluate-batch-request.schema.json");
    const defs = schema.$defs;
    const itemSchema = defs?.BatchEvaluateItem;
    expect(itemSchema).toBeDefined();
    const required = new Set(itemSchema?.required ?? []);
    for (const field of required) {
      expect(Object.keys(SAMPLE_ITEM)).toContain(field);
    }
  });

  it("EvaluateBatchResponse required fields match the schema", () => {
    const schema = loadSchema("evaluate-batch-response.schema.json");
    const required = new Set(schema.required);
    expect(required).toEqual(new Set(["batch_id", "items"]));
  });
});
