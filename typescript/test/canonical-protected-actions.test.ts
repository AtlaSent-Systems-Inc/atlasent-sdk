/**
 * Canonical protected-action bypass-resistance contract.
 *
 * For every action in the catalog (production.deploy,
 * vendor.payment.release, customer.data.export,
 * reconciliation.certify, model.agent.execute_tool) the SDK must
 * guarantee:
 *
 *   1. On `deny`: protect() throws AtlaSentDeniedError; verify is
 *      never called; no permit reaches the caller; the caller's
 *      mutation function is unreachable.
 *   2. On `allow` + verify failure (expired / consumed / revoked /
 *      mismatched / not found): protect() throws AtlaSentDeniedError;
 *      the caller's mutation function is unreachable.
 *   3. On `allow` + verify success: protect() returns a Permit
 *      carrying permitId, permitHash and auditHash. Both `evaluate`
 *      and `verifyPermit` were called once each.
 *   4. Every decision path produces an audit hash on the evaluate
 *      response so the caller can correlate with the audit log
 *      (the hash is preserved on the denied error).
 *
 * This file does not duplicate the lower-level protect.test.ts
 * coverage; it asserts the contract across every catalog action so a
 * future regression in one action does not slip past tests that only
 * exercise a single action.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockedFunction,
} from "vitest";

import atlasent, {
  AtlaSentDeniedError,
  configure,
} from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";

const CATALOG_ACTIONS = [
  "production.deploy",
  "vendor.payment.release",
  "customer.data.export",
  "reconciliation.certify",
  "model.agent.execute_tool",
] as const;

type FetchMock = MockedFunction<typeof fetch>;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetchSequence(responses: Response[]): FetchMock {
  const queue = [...responses];
  return vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("mock fetch queue exhausted");
    return next;
  }) as unknown as FetchMock;
}

function allowEvaluateWire(action: string) {
  return {
    permitted: true,
    decision_id: `dec_${action.replace(/\./g, "_")}`,
    reason: `policy authorized ${action}`,
    audit_hash: `audit_${action.replace(/\./g, "_")}`,
    timestamp: "2026-05-19T12:00:00Z",
  };
}

function denyEvaluateWire(action: string) {
  return {
    permitted: false,
    decision_id: `dec_${action.replace(/\./g, "_")}_deny`,
    reason: `policy denied ${action}: missing required constraint`,
    audit_hash: `audit_${action.replace(/\./g, "_")}_deny`,
    timestamp: "2026-05-19T12:00:00Z",
  };
}

const VERIFY_OK_WIRE = {
  verified: true,
  outcome: "verified" as const,
  permit_hash: "permit_hash_ok",
  timestamp: "2026-05-19T12:00:01Z",
};

const NON_VERIFIED_OUTCOMES = [
  "permit_expired",
  "permit_consumed",
  "permit_revoked",
  "permit_not_found",
] as const;

describe("canonical protected actions — non-bypassable execution rule", () => {
  beforeEach(() => {
    __resetSharedClientForTests();
  });

  afterEach(() => {
    __resetSharedClientForTests();
  });

  describe.each(CATALOG_ACTIONS)("%s", (action) => {
    // (1) deny path: no verify, no permit, no execution.
    it("deny: throws AtlaSentDeniedError, never calls verify, no permit reaches caller", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire(action)),
      ]);
      configure({ apiKey: "ask_test_canonical", fetch: fetchImpl });

      const mutationSpy = vi.fn();

      let caught: unknown;
      try {
        const permit = await atlasent.protect({
          agent: "actor:test",
          action,
          context: { environment: "production", resource_id: `res_${action}` },
        });
        // (Mutation gate — must be unreachable on deny.)
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(denied.auditHash).toBe(
        `audit_${action.replace(/\./g, "_")}_deny`,
      );

      // Critical: exactly one HTTP call (evaluate). Verify must not have run.
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");

      // Critical: the caller's mutation never executed.
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    // (2) allow + verify failure: blocked, mutation unreachable.
    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire(action)),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_canonical", fetch: fetchImpl });

        const mutationSpy = vi.fn();

        let caught: unknown;
        try {
          const permit = await atlasent.protect({
            agent: "actor:test",
            action,
            context: { environment: "production", resource_id: `res_${action}` },
          });
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);

        // evaluate + verify both called; mutation never reached.
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    // (3) allow + verify success: permit returned, both endpoints called.
    it("allow + verify ok: returns Permit and both endpoints were called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire(action)),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_canonical", fetch: fetchImpl });

      const permit = await atlasent.protect({
        agent: "actor:test",
        action,
        context: { environment: "production", resource_id: `res_${action}` },
      });

      expect(permit.permitId).toBe(`dec_${action.replace(/\./g, "_")}`);
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe(`audit_${action.replace(/\./g, "_")}`);

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    // (4) audit hash is carried on every decision path.
    it("preserves audit hash on deny so the caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire(action)),
      ]);
      configure({ apiKey: "ask_test_canonical", fetch: fetchImpl });

      try {
        await atlasent.protect({
          agent: "actor:test",
          action,
          context: { environment: "production", resource_id: `res_${action}` },
        });
        // The next line must be unreachable; if it executes the test fails.
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });
  });

  it("forwards the catalog action string to the evaluate body verbatim", async () => {
    // Cross-cutting check: the SDK does not rewrite or normalize the
    // catalog action string. Whatever the caller passes is what the
    // server sees, which is what the audit record will contain.
    for (const action of CATALOG_ACTIONS) {
      __resetSharedClientForTests();
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire(action)),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_canonical", fetch: fetchImpl });

      await atlasent.protect({
        agent: "actor:test",
        action,
        context: { environment: "production", resource_id: `res_${action}` },
      });

      const [, evalInit] = fetchImpl.mock.calls[0]!;
      const body = JSON.parse(evalInit!.body as string);
      // The canonical wire field is `action_type`; the legacy compat
      // shim sends both. Either is acceptable as long as the value
      // matches the catalog string verbatim.
      const onWire = body.action_type ?? body.action;
      expect(onWire).toBe(action);

      const [, verifyInit] = fetchImpl.mock.calls[1]!;
      const verifyBody = JSON.parse(verifyInit!.body as string);
      expect(verifyBody.action_type).toBe(action);
    }
  });
});
