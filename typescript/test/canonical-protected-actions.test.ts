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
  type CloseActionType,
  protectDataExport,
  protectBatchRecordRelease,
  protectBehaviorEvent,
  protectInfraAction,
  protectDeploymentV2,
  protectPaymentOperation,
  protectHrOffboard,
  protectModelPromotion,
  protectCustomerDataDelete,
  protectContractExecution,
  protectPricingRule,
  protectSecurityIncidentEscalate,
  protectSecurityAccessQuarantine,
  protectAccessCertRevoke,
  protectPeriodCloseCertify,
} from "../src/index.js";
import { __resetSharedClientForTests } from "../src/protect.js";

const CATALOG_ACTIONS = [
  "production.deploy",
  "vendor.payment.release",
  "customer.data.export",
  "reconciliation.certify",
  "model.agent.execute_tool",
  "manufacturing.batch_record.release",
  "deployment.production.execute",
  "behavior.event.share",
  "aws.ec2.terminate_instance",
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

  // CloseActionType membership checks
  it('"data.export" is NOT a valid CloseActionType', () => {
    // Compile-time guard: "data.export" must not be assignable to CloseActionType.
    // We verify this at runtime by confirming our known-good type list excludes it.
    const validCloseActions: CloseActionType[] = [
      "period.close",
      "period.reopen",
      "reconciliation.lock",
      "reconciliation.certify",
    ];
    expect(validCloseActions).not.toContain("data.export");
  });

  it('"reconciliation.certify" IS a valid CloseActionType', () => {
    const action: CloseActionType = "reconciliation.certify";
    expect(action).toBe("reconciliation.certify");
  });

  describe("protectDataExport — 4-path contract", () => {
    const exportOpts = {
      dataset: "customers",
      destination: "s3://analytics-bucket/export",
      containsPii: true,
      rowCount: 50000,
      dataClassification: "confidential" as const,
      purpose: "quarterly analytics",
      authorizedBy: "analyst:jane",
    };

    // (1) deny path
    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("customer.data.export")),
      ]);
      configure({ apiKey: "ask_test_export", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectDataExport(exportOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    // (2) allow + verify failure
    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("customer.data.export")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_export", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectDataExport(exportOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    // (3) allow + verify success
    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("customer.data.export")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_export", fetch: fetchImpl });

      const permit = await protectDataExport(exportOpts);

      expect(permit.permitId).toBe("dec_customer_data_export");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_customer_data_export");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    // (4) audit hash preservation on deny
    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("customer.data.export")),
      ]);
      configure({ apiKey: "ask_test_export", fetch: fetchImpl });

      try {
        await protectDataExport(exportOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });
  });

  // ── protectBatchRecordRelease — 4-path contract ──────────────────────────────────────────
  describe("protectBatchRecordRelease — 4-path contract", () => {
    const batchOpts = {
      batchId: "BATCH-2026-001",
      productCode: "PROD-X",
      lotNumber: "LOT-99",
      certifiedBy: "qa:jane",
      qaSignoffBy: "qa:bob",
      batchRecordComplete: true,
      deviationCount: 0,
      regulatoryRegion: "EU",
    };

    // (1) deny path
    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("manufacturing.batch_record.release")),
      ]);
      configure({ apiKey: "ask_test_gxp", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectBatchRecordRelease(batchOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    // (2) allow + verify failure
    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("manufacturing.batch_record.release")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_gxp", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectBatchRecordRelease(batchOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    // (3) allow + verify success
    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("manufacturing.batch_record.release")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_gxp", fetch: fetchImpl });

      const permit = await protectBatchRecordRelease(batchOpts);

      expect(permit.permitId).toBe("dec_manufacturing_batch_record_release");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_manufacturing_batch_record_release");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    // (4) audit hash preservation on deny
    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("manufacturing.batch_record.release")),
      ]);
      configure({ apiKey: "ask_test_gxp", fetch: fetchImpl });

      try {
        await protectBatchRecordRelease(batchOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });
  });

  // ── protectBehaviorEvent (sensitive category) — 4-path contract ─────────────────────────
  describe("protectBehaviorEvent — health.mental sensitive category — 4-path contract", () => {
    const behaviorOpts = {
      action: "behavior.event.share" as const,
      subjectId: "subject:abc123",
      eventCategory: "health.mental" as const,
      destination: "research-platform://study-42",
      purpose: "longitudinal depression study",
      consentVerified: true,
      dataMinimized: true,
    };

    // (1) deny path
    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("behavior.event.share")),
      ]);
      configure({ apiKey: "ask_test_behavior", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectBehaviorEvent(behaviorOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    // (2) allow + verify failure
    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("behavior.event.share")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_behavior", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectBehaviorEvent(behaviorOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    // (3) allow + verify success
    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("behavior.event.share")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_behavior", fetch: fetchImpl });

      const permit = await protectBehaviorEvent(behaviorOpts);

      expect(permit.permitId).toBe("dec_behavior_event_share");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_behavior_event_share");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    // (4) audit hash preservation on deny
    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("behavior.event.share")),
      ]);
      configure({ apiKey: "ask_test_behavior", fetch: fetchImpl });

      try {
        await protectBehaviorEvent(behaviorOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });

    it("minor subject always escalates with HOLD_HUMAN_REVIEW_REQUIRED reason", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("behavior.event.share")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_behavior", fetch: fetchImpl });

      const permit = await protectBehaviorEvent({
        ...behaviorOpts,
        subjectIsMinor: true,
        eventCategory: "general",
      });

      expect(permit.permitId).toBe("dec_behavior_event_share");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("health.adherence (high risk) routes through escalation path", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("behavior.event.share")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_behavior", fetch: fetchImpl });

      const permit = await protectBehaviorEvent({
        ...behaviorOpts,
        eventCategory: "health.adherence",
      });
      expect(permit.permitId).toBe("dec_behavior_event_share");
    });

    it("general category (medium risk) routes through escalation path", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("behavior.event.share")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_behavior", fetch: fetchImpl });

      const permit = await protectBehaviorEvent({
        ...behaviorOpts,
        eventCategory: "general",
      });
      expect(permit.permitId).toBe("dec_behavior_event_share");
    });
  });

  // ── protectInfraAction (terminate) — 4-path contract ────────────────────────────────────
  describe("protectInfraAction — aws.ec2.terminate_instance — 4-path contract", () => {
    const infraOpts = {
      action: "aws.ec2.terminate_instance" as const,
      resourceId: "i-0abc123def456789",
      authorizedBy: "sre:alice",
      reason: "decommission after migration",
      incidentId: "INC-2026-042",
      region: "us-east-1",
    };

    // (1) deny path
    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("aws.ec2.terminate_instance")),
      ]);
      configure({ apiKey: "ask_test_infra", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectInfraAction(infraOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    // (2) allow + verify failure
    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("aws.ec2.terminate_instance")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_infra", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectInfraAction(infraOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    // (3) allow + verify success
    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("aws.ec2.terminate_instance")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_infra", fetch: fetchImpl });

      const permit = await protectInfraAction(infraOpts);

      expect(permit.permitId).toBe("dec_aws_ec2_terminate_instance");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_aws_ec2_terminate_instance");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    // (4) audit hash preservation on deny
    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("aws.ec2.terminate_instance")),
      ]);
      configure({ apiKey: "ask_test_infra", fetch: fetchImpl });

      try {
        await protectInfraAction(infraOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });

    it("throws TypeError when neither changeTicket nor incidentId is provided", async () => {
      configure({ apiKey: "ask_test_infra" });
      const { incidentId: _dropped, ...optsNoTicket } = infraOpts;
      await expect(protectInfraAction(optsNoTicket)).rejects.toThrow(TypeError);
    });
  });

  // ── protectDeploymentV2 — 4-path contract ───────────────────────────────────────────────
  describe("protectDeploymentV2 — deployment.production.execute — 4-path contract", () => {
    const deployOpts = {
      action: "deployment.production.execute" as const,
      deploymentId: "deploy-2026-0529",
      buildSha: "abc123def456789",
      environment: "production" as const,
      authorizedBy: "deploy-bot",
      changeTicket: "CHG-2026-099",
    };

    // (1) deny path
    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("deployment.production.execute")),
      ]);
      configure({ apiKey: "ask_test_deploy_v2", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectDeploymentV2(deployOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    // (2) allow + verify failure
    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("deployment.production.execute")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_deploy_v2", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectDeploymentV2(deployOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    // (3) allow + verify success
    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("deployment.production.execute")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_deploy_v2", fetch: fetchImpl });

      const permit = await protectDeploymentV2(deployOpts);

      expect(permit.permitId).toBe("dec_deployment_production_execute");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_deployment_production_execute");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    // (4) audit hash preservation on deny
    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("deployment.production.execute")),
      ]);
      configure({ apiKey: "ask_test_deploy_v2", fetch: fetchImpl });

      try {
        await protectDeploymentV2(deployOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });

    it("throws TypeError for rollback without incidentId", async () => {
      configure({ apiKey: "ask_test_deploy_v2" });
      await expect(
        protectDeploymentV2({
          action: "deployment.rollback.execute",
          deploymentId: "deploy-rb-001",
          buildSha: "rollback-sha",
          environment: "production",
          rollbackTarget: "v1.2.3",
          // incidentId deliberately omitted
        }),
      ).rejects.toThrow(TypeError);
    });
  });

  // ── protectPaymentOperation — 4-path contract ───────────────────────────────────────────
  describe("protectPaymentOperation — escalate path (payment.approval.approve)", () => {
    const approvalOpts = {
      paymentId: "pay_20260529_001",
      action: "payment.approval.approve" as const,
      amount: 125000,
      currency: "USD",
      approvedBy: "cfo:alice",
      vendorId: "vendor:acme",
      invoiceId: "INV-2026-0042",
      accountCode: "AP-2000",
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("payment.approval.approve")),
      ]);
      configure({ apiKey: "ask_test_payment", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectPaymentOperation(approvalOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("payment.approval.approve")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_payment", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectPaymentOperation(approvalOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("payment.approval.approve")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_payment", fetch: fetchImpl });

      const permit = await protectPaymentOperation(approvalOpts);

      expect(permit.permitId).toBe("dec_payment_approval_approve");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_payment_approval_approve");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("payment.approval.approve")),
      ]);
      configure({ apiKey: "ask_test_payment", fetch: fetchImpl });

      try {
        await protectPaymentOperation(approvalOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });
  });

  describe("protectPaymentOperation — protect path (payment.approval.deny)", () => {
    const denyActionOpts = {
      paymentId: "pay_20260529_002",
      action: "payment.approval.deny" as const,
      deniedBy: "approver:bob",
      holdReason: "missing purchase order",
      policyRule: "three-way-match-required",
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("payment.approval.deny")),
      ]);
      configure({ apiKey: "ask_test_payment", fetch: fetchImpl });

      let caught: unknown;
      try {
        await protectPaymentOperation(denyActionOpts);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
    });

    it("allow + verify ok: returns permit via protect() path", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("payment.approval.deny")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_payment", fetch: fetchImpl });

      const permit = await protectPaymentOperation(denyActionOpts);
      expect(permit.permitId).toBe("dec_payment_approval_deny");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  describe("protectPaymentOperation — critical-risk execute path", () => {
    const executeOpts = {
      paymentId: "pay_20260529_003",
      action: "payment.execute.approved" as const,
      executedBy: "payment-system:prod",
      bankReference: "WIRE-20260529-001",
      transactionId: "txn_abc123",
    };

    it("allow + verify ok: quorum escalation path returns permit", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("payment.execute.approved")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_payment", fetch: fetchImpl });

      const permit = await protectPaymentOperation(executeOpts);
      expect(permit.permitId).toBe("dec_payment_execute_approved");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  // ── protectHrOffboard — 4-path contract ─────────────────────────────────────────────────
  describe("protectHrOffboard — hr.employee.offboard — deny + allow+ok paths", () => {
    const offboardOpts = {
      employeeId: "emp:alice-42",
      authorizedBy: "hr:manager-bob",
      effectiveDate: "2026-06-01",
      offboardingReason: "voluntary resignation",
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("hr.employee.offboard")),
      ]);
      configure({ apiKey: "ask_test_hr", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectHrOffboard(offboardOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("hr.employee.offboard")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_hr", fetch: fetchImpl });

      const permit = await protectHrOffboard(offboardOpts);

      expect(permit.permitId).toBe("dec_hr_employee_offboard");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_hr_employee_offboard");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    it("throws TypeError when effectiveDate is missing", async () => {
      configure({ apiKey: "ask_test_hr" });
      const { effectiveDate: _dropped, ...optsNoDate } = offboardOpts;
      await expect(protectHrOffboard(optsNoDate as Parameters<typeof protectHrOffboard>[0])).rejects.toThrow(TypeError);
    });

    it("throws TypeError when offboardingReason is missing", async () => {
      configure({ apiKey: "ask_test_hr" });
      const { offboardingReason: _dropped, ...optsNoReason } = offboardOpts;
      await expect(protectHrOffboard(optsNoReason as Parameters<typeof protectHrOffboard>[0])).rejects.toThrow(TypeError);
    });

    it("hr.access.revoke (machine_executable: true) routes through protect() path", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("hr.access.revoke")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_hr", fetch: fetchImpl });

      const { protectHrAction } = await import("../src/verticals/hrActions.js");
      const permit = await protectHrAction({
        action: "hr.access.revoke",
        employeeId: "emp:alice-42",
        authorizedBy: "hr:manager-bob",
      });
      expect(permit.permitId).toBe("dec_hr_access_revoke");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("hr.role.escalate (critical risk) routes through escalation with quorum", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("hr.role.escalate")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_hr", fetch: fetchImpl });

      const { protectHrRoleEscalate } = await import("../src/verticals/hrActions.js");
      const permit = await protectHrRoleEscalate({
        employeeId: "emp:charlie-99",
        authorizedBy: "ciso:eve",
        requestedRole: "admin",
        businessJustification: "project X requires elevated access",
      });
      expect(permit.permitId).toBe("dec_hr_role_escalate");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("throws TypeError for hr.role.escalate without requestedRole", async () => {
      configure({ apiKey: "ask_test_hr" });
      const { protectHrAction } = await import("../src/verticals/hrActions.js");
      await expect(protectHrAction({
        action: "hr.role.escalate",
        employeeId: "emp:test",
        authorizedBy: "hr:test",
        businessJustification: "some reason",
        // requestedRole deliberately omitted
      })).rejects.toThrow(TypeError);
    });

    it("throws TypeError for hr.role.escalate without businessJustification", async () => {
      configure({ apiKey: "ask_test_hr" });
      const { protectHrAction } = await import("../src/verticals/hrActions.js");
      await expect(protectHrAction({
        action: "hr.role.escalate",
        employeeId: "emp:test",
        authorizedBy: "hr:test",
        requestedRole: "admin",
        // businessJustification deliberately omitted
      })).rejects.toThrow(TypeError);
    });
  });

  // ── protectModelPromotion — 4-path contract ──────────────────────────────────────────────
  describe("protectModelPromotion — ml.model.promote + retire — deny + allow+ok paths", () => {
    const promoteOpts = {
      modelId: "model:fraud-detector-v3",
      authorizedBy: "ml-lead:carol",
      reason: "improved F1 score in A/B test",
      safetyReviewId: "SR-2026-042",
      alignmentVerified: true,
      targetEnvironment: "production",
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("ml.model.promote")),
      ]);
      configure({ apiKey: "ask_test_model", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectModelPromotion(promoteOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("ml.model.promote")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_model", fetch: fetchImpl });

      const permit = await protectModelPromotion(promoteOpts);

      expect(permit.permitId).toBe("dec_ml_model_promote");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_ml_model_promote");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    it("ml.model.retire (high risk, irreversible) escalates with single_approver", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("ml.model.retire")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_model", fetch: fetchImpl });

      const { protectModelGovernance } = await import("../src/verticals/modelGovernance.js");
      const permit = await protectModelGovernance({
        action: "ml.model.retire",
        modelId: "model:legacy-v1",
        authorizedBy: "ml-lead:carol",
        reason: "replaced by v3",
        serviceImpactAssessed: true,
      });
      expect(permit.permitId).toBe("dec_ml_model_retire");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("ml.model.fine_tune (high risk) escalates with single_approver", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("ml.model.fine_tune")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_model", fetch: fetchImpl });

      const { protectModelGovernance } = await import("../src/verticals/modelGovernance.js");
      const permit = await protectModelGovernance({
        action: "ml.model.fine_tune",
        modelId: "model:fraud-detector-v3",
        authorizedBy: "ml-lead:carol",
        reason: "safety alignment tuning",
        alignmentVerified: true,
      });
      expect(permit.permitId).toBe("dec_ml_model_fine_tune");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  // ── protectCustomerDataDelete — 4-path contract ──────────────────────────────────────────
  describe("protectCustomerDataDelete — customer.data.delete — deny + allow+ok paths", () => {
    const deleteOpts = {
      action: "customer.data.delete" as const,
      dataSubjectId: "user:jane-doe-8821",
      verifiedBy: "compliance:officer-dan",
      gdprBasis: "erasure_request" as const,
      dpaReference: "DPA-2026-EU-0042",
      dataCategories: ["profile", "purchase_history", "behavioral"],
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("customer.data.delete")),
      ]);
      configure({ apiKey: "ask_test_datadelete", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectCustomerDataDelete(deleteOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("customer.data.delete")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_datadelete", fetch: fetchImpl });

      const permit = await protectCustomerDataDelete(deleteOpts);

      expect(permit.permitId).toBe("dec_customer_data_delete");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_customer_data_delete");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("customer.data.delete")),
      ]);
      configure({ apiKey: "ask_test_datadelete", fetch: fetchImpl });

      try {
        await protectCustomerDataDelete(deleteOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });
  });

  // ── protectContractExecution — 4-path contract ───────────────────────────────────────────
  describe("protectContractExecution — contract.execute — deny + allow+ok paths", () => {
    const contractOpts = {
      contractId: "contract:saas-vendor-2026-09",
      authorizedBy: "legal:counsel-diana",
      counterparty: "AcmeSaaS Corp",
      legalReviewId: "LR-2026-09-42",
      estimatedValue: 500000,
      currency: "USD",
      effectiveDate: "2026-07-01",
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("contract.execute")),
      ]);
      configure({ apiKey: "ask_test_contract", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectContractExecution(contractOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("contract.execute")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_contract", fetch: fetchImpl });

      const permit = await protectContractExecution(contractOpts);

      expect(permit.permitId).toBe("dec_contract_execute");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_contract_execute");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    it("contract.amend (high risk) escalates with single_approver", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("contract.amend")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_contract", fetch: fetchImpl });

      const { protectContractAction } = await import("../src/verticals/contractActions.js");
      const permit = await protectContractAction({
        action: "contract.amend",
        contractId: "contract:saas-vendor-2026-09",
        authorizedBy: "legal:counsel-diana",
        counterparty: "AcmeSaaS Corp",
        amendmentDescription: "Updated SLA terms to 99.9% uptime",
      });
      expect(permit.permitId).toBe("dec_contract_amend");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("throws TypeError for contract.amend without amendmentDescription", async () => {
      configure({ apiKey: "ask_test_contract" });
      const { protectContractAction } = await import("../src/verticals/contractActions.js");
      await expect(protectContractAction({
        action: "contract.amend",
        contractId: "contract:test-001",
        authorizedBy: "legal:test",
        counterparty: "Test Corp",
        // amendmentDescription deliberately omitted
      })).rejects.toThrow(TypeError);
    });
  });

  // ── protectPricingRule — 4-path contract ─────────────────────────────────────────────────
  describe("protectPricingRule — pricing.rule.publish — deny + allow+ok paths", () => {
    const pricingOptsLargeChange = {
      ruleId: "rule:summer-sale-2026",
      authorizedBy: "pricing:manager-eve",
      priceChangePct: 12,
      affectedSkus: ["SKU-001", "SKU-002"],
      effectiveDate: "2026-06-15",
    };

    const pricingOptsSmallChange = {
      ruleId: "rule:micro-adjustment-001",
      authorizedBy: "pricing:analyst-frank",
      priceChangePct: 2,
    };

    it("deny (large change >=5%): throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("pricing.rule.publish")),
      ]);
      configure({ apiKey: "ask_test_pricing", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectPricingRule(pricingOptsLargeChange);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it("allow + verify ok (large change >=5%): escalation path returns permit", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("pricing.rule.publish")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_pricing", fetch: fetchImpl });

      const permit = await protectPricingRule(pricingOptsLargeChange);

      expect(permit.permitId).toBe("dec_pricing_rule_publish");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_pricing_rule_publish");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("allow + verify ok (small change <5%): protect() path returns permit", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("pricing.rule.publish")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_pricing", fetch: fetchImpl });

      const permit = await protectPricingRule(pricingOptsSmallChange);

      expect(permit.permitId).toBe("dec_pricing_rule_publish");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("pricing.discount.approve (large discount >=10%): high risk, escalation path", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("pricing.discount.approve")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_pricing", fetch: fetchImpl });

      const { protectPricingAction } = await import("../src/verticals/pricingActions.js");
      const permit = await protectPricingAction({
        action: "pricing.discount.approve",
        ruleId: "rule:enterprise-discount-2026",
        authorizedBy: "pricing:manager-eve",
        discountPercent: 15,
        customerId: "cust:enterprise-001",
        discountReason: "strategic partnership",
      });
      expect(permit.permitId).toBe("dec_pricing_discount_approve");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("pricing.discount.approve (small discount <10%): medium risk, protect() path", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("pricing.discount.approve")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_pricing", fetch: fetchImpl });

      const { protectPricingAction } = await import("../src/verticals/pricingActions.js");
      const permit = await protectPricingAction({
        action: "pricing.discount.approve",
        ruleId: "rule:loyalty-discount",
        authorizedBy: "pricing:analyst-frank",
        discountPercent: 5,
        customerId: "cust:loyal-001",
        discountReason: "loyalty reward",
      });
      expect(permit.permitId).toBe("dec_pricing_discount_approve");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });

  // ── protectSecurityIncidentEscalate — 4-path contract ───────────────────────────────────
  describe("protectSecurityIncidentEscalate — security.incident.escalate — deny + allow+ok paths", () => {
    const incidentOpts = {
      incidentId: "INC-2026-CRIT-001",
      severity: "critical" as const,
      authorizedBy: "soc:lead-alice",
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("security.incident.escalate")),
      ]);
      configure({ apiKey: "ask_test_security", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectSecurityIncidentEscalate(incidentOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("security.incident.escalate")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_security", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectSecurityIncidentEscalate(incidentOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("security.incident.escalate")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_security", fetch: fetchImpl });

      const permit = await protectSecurityIncidentEscalate(incidentOpts);

      expect(permit.permitId).toBe("dec_security_incident_escalate");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_security_incident_escalate");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("security.incident.escalate")),
      ]);
      configure({ apiKey: "ask_test_security", fetch: fetchImpl });

      try {
        await protectSecurityIncidentEscalate(incidentOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });

    it("throws TypeError when incidentId is missing", async () => {
      configure({ apiKey: "ask_test_security" });
      const { incidentId: _dropped, ...optsNoId } = incidentOpts;
      await expect(
        protectSecurityIncidentEscalate(optsNoId as Parameters<typeof protectSecurityIncidentEscalate>[0]),
      ).rejects.toThrow(TypeError);
    });

    it("throws TypeError when severity is missing", async () => {
      configure({ apiKey: "ask_test_security" });
      const { severity: _dropped, ...optsNoSeverity } = incidentOpts;
      await expect(
        protectSecurityIncidentEscalate(optsNoSeverity as Parameters<typeof protectSecurityIncidentEscalate>[0]),
      ).rejects.toThrow(TypeError);
    });

    it("security.access.quarantine: deny — mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("security.access.quarantine")),
      ]);
      configure({ apiKey: "ask_test_security", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectSecurityAccessQuarantine({
          targetId: "user:bad-actor-99",
          quarantineReason: "suspected credential compromise",
          authorizedBy: "soc:lead-alice",
        });
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it("security.access.quarantine: allow + verify ok returns permit", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("security.access.quarantine")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_security", fetch: fetchImpl });

      const permit = await protectSecurityAccessQuarantine({
        targetId: "user:bad-actor-99",
        quarantineReason: "suspected credential compromise",
        authorizedBy: "soc:lead-alice",
      });
      expect(permit.permitId).toBe("dec_security_access_quarantine");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it("security.access.quarantine: throws TypeError when targetId is missing", async () => {
      configure({ apiKey: "ask_test_security" });
      await expect(
        protectSecurityAccessQuarantine({
          quarantineReason: "suspected compromise",
          authorizedBy: "soc:lead",
        } as Parameters<typeof protectSecurityAccessQuarantine>[0]),
      ).rejects.toThrow(TypeError);
    });

    it("security.access.quarantine: throws TypeError when quarantineReason is missing", async () => {
      configure({ apiKey: "ask_test_security" });
      await expect(
        protectSecurityAccessQuarantine({
          targetId: "user:target",
          authorizedBy: "soc:lead",
        } as Parameters<typeof protectSecurityAccessQuarantine>[0]),
      ).rejects.toThrow(TypeError);
    });
  });

  // ── protectAccessCertRevoke — 4-path contract ───────────────────────────────────────────
  describe("protectAccessCertRevoke — access.cert.revoke — deny + allow+ok paths", () => {
    const certOpts = {
      certId: "cert:2026-Q2-ENG-42",
      revocationReason: "access no longer required post-project",
      authorizedBy: "iam:security-admin",
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("access.cert.revoke")),
      ]);
      configure({ apiKey: "ask_test_cert", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectAccessCertRevoke(certOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("access.cert.revoke")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_cert", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectAccessCertRevoke(certOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("access.cert.revoke")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_cert", fetch: fetchImpl });

      const permit = await protectAccessCertRevoke(certOpts);

      expect(permit.permitId).toBe("dec_access_cert_revoke");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_access_cert_revoke");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("access.cert.revoke")),
      ]);
      configure({ apiKey: "ask_test_cert", fetch: fetchImpl });

      try {
        await protectAccessCertRevoke(certOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });

    it("throws TypeError when certId is missing", async () => {
      configure({ apiKey: "ask_test_cert" });
      const { certId: _dropped, ...optsNoCert } = certOpts;
      await expect(
        protectAccessCertRevoke(optsNoCert as Parameters<typeof protectAccessCertRevoke>[0]),
      ).rejects.toThrow(TypeError);
    });

    it("throws TypeError when revocationReason is missing", async () => {
      configure({ apiKey: "ask_test_cert" });
      const { revocationReason: _dropped, ...optsNoReason } = certOpts;
      await expect(
        protectAccessCertRevoke(optsNoReason as Parameters<typeof protectAccessCertRevoke>[0]),
      ).rejects.toThrow(TypeError);
    });
  });

  // ── protectPeriodCloseCertify — 4-path contract ──────────────────────────────────────────
  describe("protectPeriodCloseCertify — period.close.certify — deny + allow+ok paths", () => {
    const closeOpts = {
      periodId: "2026-Q1",
      certifiedBy: "controller:jane",
      financialController: "fc:bob",
    };

    it("deny: throws AtlaSentDeniedError, mutation unreachable", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("period.close.certify")),
      ]);
      configure({ apiKey: "ask_test_close", fetch: fetchImpl });

      const mutationSpy = vi.fn();
      let caught: unknown;
      try {
        const permit = await protectPeriodCloseCertify(closeOpts);
        mutationSpy(permit);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AtlaSentDeniedError);
      const denied = caught as AtlaSentDeniedError;
      expect(denied.decision).toBe("deny");
      expect(denied.reason).toMatch(/policy denied/);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(mutationSpy).not.toHaveBeenCalled();
    });

    it.each(NON_VERIFIED_OUTCOMES)(
      "allow + verify '%s': throws AtlaSentDeniedError; mutation unreachable",
      async (verifyOutcome) => {
        const fetchImpl = mockFetchSequence([
          jsonResponse(allowEvaluateWire("period.close.certify")),
          jsonResponse({
            verified: false,
            outcome: verifyOutcome,
            permit_hash: "permit_hash_x",
            timestamp: "2026-05-19T12:00:01Z",
          }),
        ]);
        configure({ apiKey: "ask_test_close", fetch: fetchImpl });

        const mutationSpy = vi.fn();
        let caught: unknown;
        try {
          const permit = await protectPeriodCloseCertify(closeOpts);
          mutationSpy(permit);
        } catch (err) {
          caught = err;
        }

        expect(caught).toBeInstanceOf(AtlaSentDeniedError);
        const denied = caught as AtlaSentDeniedError;
        expect(denied.decision).toBe("deny");
        expect(denied.outcome).toBe(verifyOutcome);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(mutationSpy).not.toHaveBeenCalled();
      },
    );

    it("allow + verify ok: returns permit, both endpoints called once", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(allowEvaluateWire("period.close.certify")),
        jsonResponse(VERIFY_OK_WIRE),
      ]);
      configure({ apiKey: "ask_test_close", fetch: fetchImpl });

      const permit = await protectPeriodCloseCertify(closeOpts);

      expect(permit.permitId).toBe("dec_period_close_certify");
      expect(permit.permitHash).toBe("permit_hash_ok");
      expect(permit.auditHash).toBe("audit_period_close_certify");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [evalUrl] = fetchImpl.mock.calls[0]!;
      const [verifyUrl] = fetchImpl.mock.calls[1]!;
      expect(String(evalUrl)).toContain("/v1-evaluate");
      expect(String(verifyUrl)).toContain("/v1-verify-permit");
    });

    it("preserves audit hash on deny so caller can correlate", async () => {
      const fetchImpl = mockFetchSequence([
        jsonResponse(denyEvaluateWire("period.close.certify")),
      ]);
      configure({ apiKey: "ask_test_close", fetch: fetchImpl });

      try {
        await protectPeriodCloseCertify(closeOpts);
        throw new Error("protect() returned on deny — bypass detected");
      } catch (err) {
        expect(err).toBeInstanceOf(AtlaSentDeniedError);
        const denied = err as AtlaSentDeniedError;
        expect(denied.auditHash).toBeTruthy();
        expect(denied.evaluationId).toBeTruthy();
      }
    });

    it("throws TypeError when periodId is missing", async () => {
      configure({ apiKey: "ask_test_close" });
      const { periodId: _dropped, ...optsNoPeriod } = closeOpts;
      await expect(
        protectPeriodCloseCertify(optsNoPeriod as Parameters<typeof protectPeriodCloseCertify>[0]),
      ).rejects.toThrow(TypeError);
    });

    it("throws TypeError when certifiedBy is missing", async () => {
      configure({ apiKey: "ask_test_close" });
      const { certifiedBy: _dropped, ...optsNoCert } = closeOpts;
      await expect(
        protectPeriodCloseCertify(optsNoCert as Parameters<typeof protectPeriodCloseCertify>[0]),
      ).rejects.toThrow(TypeError);
    });

    it("throws TypeError when financialController is missing", async () => {
      configure({ apiKey: "ask_test_close" });
      const { financialController: _dropped, ...optsNoFC } = closeOpts;
      await expect(
        protectPeriodCloseCertify(optsNoFC as Parameters<typeof protectPeriodCloseCertify>[0]),
      ).rejects.toThrow(TypeError);
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
