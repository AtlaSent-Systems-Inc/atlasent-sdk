/**
 * Contract vector runner for the TypeScript v2 SDK.
 *
 * Loads contract/vectors/v2/{evaluate-batch,consume,bulk-revoke}.json
 * and asserts that the SDK serialises/deserialises each vector exactly:
 * the body sent to the server matches wire_request, and the parsed
 * response matches sdk_output (both in snake_case wire format).
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  V2Client,
  type BatchEvaluateItem,
  type BulkRevokeResponse,
  type ConsumeResponse,
  type EvaluateBatchResponse,
} from "../src/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const V2_VECTORS = resolve(HERE, "..", "..", "..", "..", "contract", "vectors", "v2");
const API_KEY = "ask_live_test_key";

function loadVectors(name: string): Record<string, unknown>[] {
  const raw = readFileSync(resolve(V2_VECTORS, name), "utf8");
  return (JSON.parse(raw) as { vectors: Record<string, unknown>[] }).vectors;
}

function mockFetch(status: number, body: unknown): typeof fetch {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  ) as unknown as typeof fetch;
}

function captureFetch(
  responseBody: unknown,
  captured: { url: string; body: Record<string, unknown> },
): typeof fetch {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    captured.url = String(url);
    captured.body = JSON.parse(init?.body as string) as Record<string, unknown>;
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

// ── evaluate-batch ────────────────────────────────────────────────────────

describe("contract vectors — evaluateBatch", () => {
  const vectors = loadVectors("evaluate-batch.json");

  for (const v of vectors) {
    const name = v.name as string;
    const sdkInput = v.sdk_input as { requests: BatchEvaluateItem[] };
    const wireRequest = v.wire_request as Record<string, unknown>;
    const wireResponse = v.wire_response as EvaluateBatchResponse;
    const sdkOutput = v.sdk_output as EvaluateBatchResponse;

    it(`${name} — wire_request`, async () => {
      const captured = { url: "", body: {} as Record<string, unknown> };
      const client = new V2Client({
        apiKey: API_KEY,
        fetch: captureFetch(wireResponse, captured),
      });
      await client.evaluateBatch(sdkInput.requests);
      expect(captured.body).toEqual(wireRequest);
    });

    it(`${name} — response parsed`, async () => {
      const client = new V2Client({
        apiKey: API_KEY,
        fetch: mockFetch(200, wireResponse),
      });
      const result = await client.evaluateBatch(sdkInput.requests);
      expect(result.batch_id).toBe(sdkOutput.batch_id);
      expect(result.items).toHaveLength(sdkOutput.items.length);
      for (let i = 0; i < sdkOutput.items.length; i++) {
        expect(result.items[i].permitted).toBe(sdkOutput.items[i].permitted);
        expect(result.items[i].decision_id).toBe(sdkOutput.items[i].decision_id);
        expect(result.items[i].audit_hash).toBe(sdkOutput.items[i].audit_hash);
      }
    });
  }
});

// ── consume ───────────────────────────────────────────────────────────────

describe("contract vectors — consume", () => {
  interface ConsumeVectorInput {
    permitId: string;
    payloadHash: string;
    executionStatus: "executed" | "failed";
    executionHash?: string;
  }

  const vectors = loadVectors("consume.json");

  for (const v of vectors) {
    const name = v.name as string;
    const sdkInput = v.sdk_input as ConsumeVectorInput;
    const wireRequest = v.wire_request as Record<string, unknown>;
    const wireResponse = v.wire_response as ConsumeResponse;
    const sdkOutput = v.sdk_output as ConsumeResponse;

    it(`${name} — wire_request`, async () => {
      const captured = { url: "", body: {} as Record<string, unknown> };
      const client = new V2Client({
        apiKey: API_KEY,
        fetch: captureFetch(wireResponse, captured),
      });
      await client.consume({
        permitId: sdkInput.permitId,
        payloadHash: sdkInput.payloadHash,
        executionStatus: sdkInput.executionStatus,
        ...(sdkInput.executionHash !== undefined
          ? { executionHash: sdkInput.executionHash }
          : {}),
      });
      expect(captured.body).toEqual(wireRequest);
    });

    it(`${name} — response parsed`, async () => {
      const client = new V2Client({
        apiKey: API_KEY,
        fetch: mockFetch(200, wireResponse),
      });
      const result = await client.consume({
        permitId: sdkInput.permitId,
        payloadHash: sdkInput.payloadHash,
        executionStatus: sdkInput.executionStatus,
      });
      expect(result.proof_id).toBe(sdkOutput.proof_id);
      expect(result.execution_status).toBe(sdkOutput.execution_status);
      expect(result.audit_hash).toBe(sdkOutput.audit_hash);
    });
  }
});

// ── bulk-revoke ───────────────────────────────────────────────────────────

describe("contract vectors — bulkRevoke", () => {
  interface BulkRevokeVectorInput {
    workflowId: string;
    runId: string;
    reason: string;
    revokerId?: string;
  }

  const vectors = loadVectors("bulk-revoke.json");

  for (const v of vectors) {
    const name = v.name as string;
    const sdkInput = v.sdk_input as BulkRevokeVectorInput;
    const wireRequest = v.wire_request as Record<string, unknown>;
    const wireResponse = v.wire_response as BulkRevokeResponse;
    const sdkOutput = v.sdk_output as BulkRevokeResponse;

    it(`${name} — wire_request`, async () => {
      const captured = { url: "", body: {} as Record<string, unknown> };
      const client = new V2Client({
        apiKey: API_KEY,
        fetch: captureFetch(wireResponse, captured),
      });
      await client.bulkRevoke({
        workflowId: sdkInput.workflowId,
        runId: sdkInput.runId,
        reason: sdkInput.reason,
        ...(sdkInput.revokerId !== undefined
          ? { revokerId: sdkInput.revokerId }
          : {}),
      });
      expect(captured.body).toEqual(wireRequest);
    });

    it(`${name} — response parsed`, async () => {
      const client = new V2Client({
        apiKey: API_KEY,
        fetch: mockFetch(200, wireResponse),
      });
      const result = await client.bulkRevoke({
        workflowId: sdkInput.workflowId,
        runId: sdkInput.runId,
        reason: sdkInput.reason,
      });
      expect(result.revoked_count).toBe(sdkOutput.revoked_count);
      expect(result.workflow_id).toBe(sdkOutput.workflow_id);
      expect(result.run_id).toBe(sdkOutput.run_id);
    });
  }
});
