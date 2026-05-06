/**
 * Tests for Dispute + Reversal Workflows.
 *
 * Covers: dispute state transitions, reversal stage transitions,
 * freeze activity checks, and remediation urgency computation.
 */
import { describe, expect, it } from "vitest";
import {
  computeRemediationUrgency,
  isFreezeActive,
  transitionDispute,
  transitionReversal,
  type ActionFreeze,
} from "../src/disputeReversal.js";

describe("transitionDispute", () => {
  it("allows open → under_review", () => {
    const { success } = transitionDispute("open", "under_review");
    expect(success).toBe(true);
  });

  it("allows open → withdrawn", () => {
    const { success } = transitionDispute("open", "withdrawn");
    expect(success).toBe(true);
  });

  it("rejects open → resolved_in_favor (skip)", () => {
    const { success, error } = transitionDispute("open", "resolved_in_favor");
    expect(success).toBe(false);
    expect(error).toContain("open");
  });

  it("allows under_review → escalated", () => {
    expect(transitionDispute("under_review", "escalated").success).toBe(true);
  });

  it("allows under_review → reversed", () => {
    expect(transitionDispute("under_review", "reversed").success).toBe(true);
  });

  it("allows escalated → resolved_against", () => {
    expect(transitionDispute("escalated", "resolved_against").success).toBe(true);
  });

  it("rejects transition from terminal state resolved_in_favor", () => {
    const { success } = transitionDispute("resolved_in_favor", "open");
    expect(success).toBe(false);
  });

  it("rejects transition from terminal state reversed", () => {
    const { success } = transitionDispute("reversed", "open");
    expect(success).toBe(false);
  });
});

describe("transitionReversal", () => {
  it("allows initiated → authorization_pending", () => {
    expect(transitionReversal("initiated", "authorization_pending").success).toBe(true);
  });

  it("allows authorization_pending → authorized", () => {
    expect(transitionReversal("authorization_pending", "authorized").success).toBe(true);
  });

  it("allows authorized → executing", () => {
    expect(transitionReversal("authorized", "executing").success).toBe(true);
  });

  it("allows executing → completed", () => {
    expect(transitionReversal("executing", "completed").success).toBe(true);
  });

  it("allows executing → failed", () => {
    expect(transitionReversal("executing", "failed").success).toBe(true);
  });

  it("allows failed → initiated (retry)", () => {
    expect(transitionReversal("failed", "initiated").success).toBe(true);
  });

  it("rejects completed → initiated", () => {
    const { success } = transitionReversal("completed", "initiated");
    expect(success).toBe(false);
  });

  it("allows cancellation from initiated", () => {
    expect(transitionReversal("initiated", "cancelled").success).toBe(true);
  });

  it("allows cancellation from authorization_pending", () => {
    expect(transitionReversal("authorization_pending", "cancelled").success).toBe(true);
  });
});

describe("isFreezeActive", () => {
  const BASE_FREEZE: ActionFreeze = {
    freeze_id:     "frz-001",
    execution_id:  "exec-001",
    org_id:        "org-abc",
    triggered_by:  "system",
    reason:        "fraud detection",
    triggered_at:  "2026-01-01T00:00:00Z",
    expires_at:    null,
    lifted:        false,
    lifted_at:     null,
    lifted_by:     null,
    frozen_status: "frozen",
  };

  it("returns true for an active indefinite freeze", () => {
    expect(isFreezeActive(BASE_FREEZE)).toBe(true);
  });

  it("returns false when freeze is lifted", () => {
    expect(isFreezeActive({ ...BASE_FREEZE, lifted: true, lifted_at: "2026-01-02T00:00:00Z", lifted_by: "admin" })).toBe(false);
  });

  it("returns false when freeze has expired", () => {
    const freeze: ActionFreeze = {
      ...BASE_FREEZE,
      expires_at: "2026-01-01T12:00:00Z",
    };
    expect(isFreezeActive(freeze, new Date("2026-01-02T00:00:00Z"))).toBe(false);
  });

  it("returns true when freeze has not yet expired", () => {
    const freeze: ActionFreeze = {
      ...BASE_FREEZE,
      expires_at: "2026-01-10T00:00:00Z",
    };
    expect(isFreezeActive(freeze, new Date("2026-01-05T00:00:00Z"))).toBe(true);
  });
});

describe("computeRemediationUrgency", () => {
  const openedAt = "2026-01-01T00:00:00Z";

  it("returns normal when no deadline", () => {
    expect(computeRemediationUrgency(openedAt, null)).toBe("normal");
  });

  it("returns overdue when past deadline", () => {
    const result = computeRemediationUrgency(
      openedAt,
      "2026-01-01T12:00:00Z",
      new Date("2026-01-02T00:00:00Z"),
    );
    expect(result).toBe("overdue");
  });

  it("returns urgent when less than 24h remain", () => {
    const result = computeRemediationUrgency(
      openedAt,
      "2026-01-02T00:00:00Z",
      new Date("2026-01-01T14:00:00Z"),
    );
    expect(result).toBe("urgent");
  });

  it("returns normal when more than 24h remain", () => {
    const result = computeRemediationUrgency(
      openedAt,
      "2026-01-10T00:00:00Z",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(result).toBe("normal");
  });
});
