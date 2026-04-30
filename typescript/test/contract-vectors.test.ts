/**
 * Contract vector runner for the TypeScript SDK.
 *
 * Loads contract/vectors/{evaluate,verify,errors}.json from the repo
 * root and asserts that the SDK serializes / deserializes each vector
 * exactly. Failures here mean the TS SDK has drifted from the shared
 * contract that every AtlaSent SDK targets.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { AtlaSentClient, AtlaSentError } from "../src/index.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const VECTORS_DIR = resolve(HERE, "..", "..", "contract", "vectors");
const API_KEY = "ask_live_test_key";

interface EvaluateVector {
  name: string;
  sdk_input: { agent: string; action: string; context?: Record<string, unknown> };
  api_key: string;
  wire_request: Record<string, unknown>;
  wire_response: Record<string, unknown>;
  sdk_output?: {
    decision: "ALLOW" | "DENY";
    permit_id: string;
    reason: string;
    audit_hash: string;
    timestamp: string;
  };
  sdk_error?: { kind: string; message_contains?: string };
}

interface VerifyVector {
  name: string;
  sdk_input: {
    permit_id: string;
    action?: string;
    agent?: string;
    context?: Record<string, unknown>;
  };
  api_key: string;
  wire_request: Record<string, unknown>;
  wire_response: Record<string, unknown>;
  sdk_output?: {
    verified: boolean;
    outcome: string;
    permit_hash: string;
    timestamp: string;
  };
  sdk_error?: { kind: string; message_contains?: string };
}

interface ErrorVector {
  name: string;
  http_status?: number;
  response_headers?: Record<string, string>;
  response_body?: unknown;
  transport?: "timeout" | "connection_refused";
  sdk_error: {
    kind: string;
    status?: number;
    message_contains?: string;
    retry_after_seconds?: number;
  };
}

function loadVectors<T>(name: string): T[] {
  const raw = JSON.parse(readFileSync(resolve(VECTORS_DIR, name), "utf-8"));
  return raw.vectors as T[];
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function makeClient(fetchImpl: typeof fetch) {
  return new AtlaSentClient({
    apiKey: API_KEY,
    fetch: fetchImpl,
    timeoutMs: 5_000,
  });
}

// ── evaluate.json ────────────────────────────────────────────────────

describe("evaluate vectors", () => {
  for (const vector of loadVectors<EvaluateVector>("evaluate.json")) {
    it(vector.name, async () => {
      let captured: { url: string; init: RequestInit } | undefined;
      const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        captured = { url, init: init ?? {} };
        if (vector.sdk_error) {
          // bad_response vectors: still serve the body, the SDK MUST raise.
          return jsonResponse(vector.wire_response);
        }
        return jsonResponse(vector.wire_response);
      }) as unknown as typeof fetch;

      const client = makeClient(fetchImpl);

      const evaluateInput: {
        agent: string;
        action: string;
        context?: Record<string, unknown>;
      } = {
        agent: vector.sdk_input.agent,
        action: vector.sdk_input.action,
      };
      if (vector.sdk_input.context !== undefined) {
        evaluateInput.context = vector.sdk_input.context;
      }

      if (vector.sdk_error) {
        await expect(client.evaluate(evaluateInput)).rejects.toMatchObject({
          name: "AtlaSentError",
          code: vector.sdk_error.kind,
        });
      } else {
        const result = await client.evaluate(evaluateInput);
        const expected = vector.sdk_output!;
        expect(result.decision).toBe(expected.decision);
        expect(result.permitId).toBe(expected.permit_id);
        expect(result.reason).toBe(expected.reason);
        expect(result.auditHash).toBe(expected.audit_hash);
        expect(result.timestamp).toBe(expected.timestamp);
      }

      // Wire-format assertion.
      expect(captured).toBeDefined();
      expect(captured!.url).toMatch(/\/v1-evaluate$/);
      const sentBody = JSON.parse(captured!.init.body as string);
      expect(sentBody).toEqual(vector.wire_request);
    });
  }
});

// ── verify.json ──────────────────────────────────────────────────────

describe("verify vectors", () => {
  for (const vector of loadVectors<VerifyVector>("verify.json")) {
    it(vector.name, async () => {
      let captured: { url: string; init: RequestInit } | undefined;
      const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        captured = { url, init: init ?? {} };
        return jsonResponse(vector.wire_response);
      }) as unknown as typeof fetch;

      const client = makeClient(fetchImpl);

      const verifyInput: {
        permitId: string;
        action?: string;
        agent?: string;
        context?: Record<string, unknown>;
      } = { permitId: vector.sdk_input.permit_id };
      if (vector.sdk_input.action !== undefined) verifyInput.action = vector.sdk_input.action;
      if (vector.sdk_input.agent !== undefined) verifyInput.agent = vector.sdk_input.agent;
      if (vector.sdk_input.context !== undefined) verifyInput.context = vector.sdk_input.context;

      if (vector.sdk_error) {
        await expect(client.verifyPermit(verifyInput)).rejects.toMatchObject({
          name: "AtlaSentError",
          code: vector.sdk_error.kind,
        });
      } else {
        const result = await client.verifyPermit(verifyInput);
        const expected = vector.sdk_output!;
        expect(result.verified).toBe(expected.verified);
        expect(result.outcome).toBe(expected.outcome);
        expect(result.permitHash).toBe(expected.permit_hash);
        expect(result.timestamp).toBe(expected.timestamp);
      }

      expect(captured).toBeDefined();
      expect(captured!.url).toMatch(/\/v1-verify-permit$/);
      const sentBody = JSON.parse(captured!.init.body as string);
      expect(sentBody).toEqual(vector.wire_request);
    });
  }
});

// ── errors.json ──────────────────────────────────────────────────────

describe("error vectors", () => {
  for (const vector of loadVectors<ErrorVector>("errors.json")) {
    it(vector.name, async () => {
      let fetchImpl: typeof fetch;

      if (vector.transport === "timeout") {
        fetchImpl = vi.fn(async () => {
          throw new DOMException("timed out", "TimeoutError");
        }) as unknown as typeof fetch;
      } else if (vector.transport === "connection_refused") {
        fetchImpl = vi.fn(async () => {
          throw new TypeError("fetch failed: ECONNREFUSED");
        }) as unknown as typeof fetch;
      } else {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...(vector.response_headers ?? {}),
        };
        const body =
          typeof vector.response_body === "string"
            ? vector.response_body
            : JSON.stringify(vector.response_body ?? {});
        fetchImpl = vi.fn(
          async () =>
            new Response(body, {
              status: vector.http_status ?? 500,
              headers,
            }),
        ) as unknown as typeof fetch;
      }

      const client = makeClient(fetchImpl);
      const expected: Record<string, unknown> = {
        name: "AtlaSentError",
        code: vector.sdk_error.kind,
      };
      if (vector.sdk_error.status !== undefined) {
        expected.status = vector.sdk_error.status;
      }
      if (vector.sdk_error.retry_after_seconds !== undefined) {
        expected.retryAfterMs = vector.sdk_error.retry_after_seconds * 1000;
      }

      const promise = client.evaluate({ agent: "a", action: "b" });
      await expect(promise).rejects.toMatchObject(expected);

      if (vector.sdk_error.message_contains) {
        await promise.catch((err: AtlaSentError) => {
          expect(err.message).toContain(vector.sdk_error.message_contains!);
        });
      }
    });
  }
});
