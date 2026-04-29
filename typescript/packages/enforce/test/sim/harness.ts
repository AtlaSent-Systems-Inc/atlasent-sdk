/**
 * Shared test harness for SIM-01..SIM-10.
 * Loads a fixture JSON file and provides mock client builders that match the
 * fixture's `mocks` spec. Both TS and Python share the same JSON fixtures;
 * this file is the TS side of the harness.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  EnforceCompatibleClient,
  EvaluateResponse,
  VerifiedPermit,
} from "../../src/index.js";

const SCENARIOS_DIR = join(
  new URL(".", import.meta.url).pathname,
  "../../../../contract/scenarios",
);

export function loadFixture(simId: string): SimFixture {
  const raw = readFileSync(join(SCENARIOS_DIR, `${simId}.json`), "utf-8");
  return JSON.parse(raw) as SimFixture;
}

// ── Fixture types (mirrors the JSON schema) ─────────────────────────────────

interface PermitStub {
  token: string;
  expires_at: string;
}

interface VerifiedPermitStub {
  token: string;
  org_id: string;
  actor_id: string;
  action_type: string;
  expires_at: string;
}

interface EvaluateMock {
  type: "response" | "http_error";
  decision?: string;
  permit?: PermitStub | null;
  reason_code?: string | null;
  http_status?: number;
}

interface VerifyMock {
  type: "response" | "http_error" | "delayed" | "sequence" | "concurrent_sequence";
  verified_permit?: VerifiedPermitStub;
  http_status?: number;
  reason_code?: string | null;
  delay_ms?: number;
  then?: VerifyMock;
  responses?: VerifyMock[];
  tamper_token?: boolean;
}

export interface SimFixture {
  id: string;
  title: string;
  enforce_config: {
    bindings: { org_id: string; actor_id: string; action_type: string };
    fail_closed: boolean;
    latency_budget_ms?: number;
  };
  clock: { now_iso: string };
  request: Record<string, unknown>;
  mocks: {
    evaluate: EvaluateMock;
    verify_permit: VerifyMock | null;
  };
  cases?: Array<{
    label: string;
    latency_breach_mode: "deny" | "warn";
    expected: {
      decision: string;
      reason_code?: string | null;
      execute_called: boolean;
      verify_permit_called: boolean;
      warn_emitted?: boolean;
    };
  }>;
  expected?: {
    decision?: string;
    reason_code?: string | null;
    execute_called?: boolean;
    verify_permit_called?: boolean;
    warn_emitted?: boolean;
    phases?: Array<{
      label: string;
      decision: string;
      reason_code?: string | null;
      execute_called: boolean;
      verify_permit_called: boolean;
    }>;
    concurrent_calls?: number;
    allow_count?: number;
    deny_count?: number;
    deny_reason_code?: string;
    execute_call_count?: number;
  };
}

// ── Client error class used by mocks ─────────────────────────────────────────

export class MockClientError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly reasonCode: string | null | undefined,
  ) {
    super(`HTTP ${httpStatus}${reasonCode ? `: ${reasonCode}` : ""}`);
    this.name = "MockClientError";
  }
}

// ── Evaluate mock builder ─────────────────────────────────────────────────────

function buildEvaluateMock(spec: EvaluateMock): () => Promise<EvaluateResponse> {
  return async () => {
    if (spec.type === "http_error") {
      throw new MockClientError(spec.http_status!, spec.reason_code);
    }
    const permit = spec.permit
      ? { token: spec.permit.token, expiresAt: spec.permit.expires_at }
      : undefined;
    return {
      decision: spec.decision as EvaluateResponse["decision"],
      permit,
      reasonCode: spec.reason_code ?? undefined,
    };
  };
}

// ── VerifyPermit mock builder ─────────────────────────────────────────────────

function stubToVerifiedPermit(s: VerifiedPermitStub): VerifiedPermit {
  return {
    token: s.token,
    orgId: s.org_id,
    actorId: s.actor_id,
    actionType: s.action_type,
    expiresAt: s.expires_at,
  };
}

function buildSingleVerifyResponse(
  spec: VerifyMock,
): () => Promise<VerifiedPermit> {
  return async () => {
    if (spec.type === "http_error") {
      throw new MockClientError(spec.http_status!, spec.reason_code);
    }
    if (spec.type === "delayed") {
      await new Promise((r) => setTimeout(r, spec.delay_ms!));
      return buildSingleVerifyResponse(spec.then!)();
    }
    return stubToVerifiedPermit(spec.verified_permit!);
  };
}

export function buildMockClient(
  evaluateSpec: EvaluateMock,
  verifySpec: VerifyMock | null,
  options: { tamperToken?: boolean } = {},
): { client: EnforceCompatibleClient; verifyCalls: number } {
  const state = { verifyCalls: 0, sequenceIndex: 0 };
  const evaluateFn = buildEvaluateMock(evaluateSpec);

  let verifyFn: ((token: string) => Promise<VerifiedPermit>) | null = null;

  if (verifySpec) {
    if (verifySpec.type === "sequence" || verifySpec.type === "concurrent_sequence") {
      const responses = verifySpec.responses!;
      verifyFn = async (_token) => {
        const idx = state.sequenceIndex++;
        const resp = responses[idx] ?? responses[responses.length - 1]!;
        return buildSingleVerifyResponse(resp)();
      };
    } else {
      const single = buildSingleVerifyResponse(verifySpec);
      verifyFn = async (token) => {
        const t = options.tamperToken ? token + "X" : token;
        void t;
        return single();
      };
    }
  }

  const client: EnforceCompatibleClient = {
    evaluate: evaluateFn,
    async verifyPermit(token: string): Promise<VerifiedPermit> {
      state.verifyCalls++;
      if (!verifyFn) throw new Error("verify_permit called unexpectedly");
      return verifyFn(token);
    },
  };

  return {
    client,
    get verifyCalls() { return state.verifyCalls; },
  };
}
