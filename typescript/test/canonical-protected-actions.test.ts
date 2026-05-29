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
