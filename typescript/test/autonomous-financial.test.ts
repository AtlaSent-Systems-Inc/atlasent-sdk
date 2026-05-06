/**
 * Tests for Autonomous Financial Execution bounds checking and anomaly detection.
 *
 * Covers: action type gating, per-execution ceilings, daily aggregate ceilings,
 * risk tier limits, bounds expiry, daily count limits, and anomaly detection.
 */
import { describe, expect, it } from "vitest";
import {
  checkAutonomousBounds,
  detectAutonomousAnomaly,
  type AutonomousExecutionBounds,
  type ExecutionCeiling,
} from "../src/autonomousFinancial.js";

const REFUND_CEILING: ExecutionCeiling = {
  action_type:          "refund",
  per_execution_max:    500,
  currency:             "USD",
  max_daily_count:      50,
  require_permit:       false,
};

const BASE_BOUNDS: AutonomousExecutionBounds = {
  bounds_id:                    "bnds-001",
  org_id:                       "org-abc",
  agent_id:                     "agent-refund-bot",
  agent_name:                   "Refund Bot",
  permitted_action_types:       ["refund", "vendor_payment"],
  ceilings:                     [REFUND_CEILING],
  daily_aggregate_ceiling:      10_000,
  aggregate_currency:           "USD",
  max_risk_tier:                "medium",
  require_runtime_verification: true,
  anomaly_detection_enabled:    true,
  created_at:                   "2026-01-01T00:00:00Z",
  expires_at:                   null,
  active:                       true,
};

const BASE_PARAMS = {
  bounds:               BASE_BOUNDS,
  actionType:           "refund" as const,
  actionValue:          100,
  currency:             "USD" as const,
  riskTier:             "low" as const,
  currentDailyAggregate: 0,
  currentDailyCount:    {},
};

describe("checkAutonomousBounds", () => {
  it("permits a standard refund within all bounds", () => {
    const result = checkAutonomousBounds(BASE_PARAMS);
    expect(result.permitted).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it("denies when action type is not in permitted set", () => {
    const result = checkAutonomousBounds({ ...BASE_PARAMS, actionType: "wire_transfer" });
    expect(result.permitted).toBe(false);
    expect(result.action_type_permitted).toBe(false);
    expect(result.violations.some((v) => v.includes("wire_transfer"))).toBe(true);
  });

  it("denies when value exceeds per-execution ceiling", () => {
    const result = checkAutonomousBounds({ ...BASE_PARAMS, actionValue: 600 });
    expect(result.permitted).toBe(false);
    expect(result.within_execution_ceiling).toBe(false);
  });

  it("denies when daily aggregate would exceed ceiling", () => {
    const result = checkAutonomousBounds({
      ...BASE_PARAMS,
      actionValue: 500,
      currentDailyAggregate: 9_800,
    });
    expect(result.permitted).toBe(false);
    expect(result.within_daily_aggregate).toBe(false);
  });

  it("denies when risk tier exceeds agent max", () => {
    const result = checkAutonomousBounds({ ...BASE_PARAMS, riskTier: "high" });
    expect(result.permitted).toBe(false);
    expect(result.within_risk_tier).toBe(false);
  });

  it("denies when bounds are inactive", () => {
    const bounds = { ...BASE_BOUNDS, active: false };
    const result = checkAutonomousBounds({ ...BASE_PARAMS, bounds });
    expect(result.permitted).toBe(false);
    expect(result.bounds_active).toBe(false);
  });

  it("denies when bounds have expired", () => {
    const bounds = { ...BASE_BOUNDS, expires_at: "2025-12-31T23:59:59Z" };
    const result = checkAutonomousBounds({
      ...BASE_PARAMS,
      bounds,
      now: new Date("2026-01-15T12:00:00Z"),
    });
    expect(result.permitted).toBe(false);
    expect(result.bounds_not_expired).toBe(false);
  });

  it("denies when daily count limit is reached", () => {
    const result = checkAutonomousBounds({
      ...BASE_PARAMS,
      currentDailyCount: { refund: 50 },
    });
    expect(result.permitted).toBe(false);
    expect(result.within_execution_ceiling).toBe(false);
  });

  it("returns the applicable ceiling in the result", () => {
    const result = checkAutonomousBounds(BASE_PARAMS);
    expect(result.applicable_ceiling?.action_type).toBe("refund");
  });

  it("returns null applicable_ceiling for action type with no ceiling", () => {
    const result = checkAutonomousBounds({ ...BASE_PARAMS, actionType: "vendor_payment" });
    expect(result.applicable_ceiling).toBeNull();
  });

  it("medium risk tier is within medium max_risk_tier", () => {
    const result = checkAutonomousBounds({ ...BASE_PARAMS, riskTier: "medium", actionValue: 100 });
    expect(result.within_risk_tier).toBe(true);
  });
});

describe("detectAutonomousAnomaly", () => {
  const BASE = {
    actionValue:          100,
    historicalMeanValue:  100,
    historicalStdDev:     10,
    recentExecutionCount: 5,
    burstThreshold:       20,
    isOffHours:           false,
  };

  it("returns no anomaly for normal execution", () => {
    const { anomalyDetected } = detectAutonomousAnomaly(BASE);
    expect(anomalyDetected).toBe(false);
  });

  it("detects anomaly when value is >3σ from mean", () => {
    const { anomalyDetected, description } = detectAutonomousAnomaly({
      ...BASE,
      actionValue: 200, // (200-100)/10 = 10σ
    });
    expect(anomalyDetected).toBe(true);
    expect(description).toContain("σ");
  });

  it("detects burst when execution count exceeds threshold", () => {
    const { anomalyDetected, description } = detectAutonomousAnomaly({
      ...BASE,
      recentExecutionCount: 25,
    });
    expect(anomalyDetected).toBe(true);
    expect(description).toContain("burst");
  });

  it("detects off-hours anomaly for above-average value", () => {
    const { anomalyDetected } = detectAutonomousAnomaly({
      ...BASE,
      actionValue:  250,
      isOffHours:   true,
    });
    expect(anomalyDetected).toBe(true);
  });

  it("does not flag off-hours when value is normal", () => {
    const { anomalyDetected } = detectAutonomousAnomaly({
      ...BASE,
      actionValue: 90,
      isOffHours:  true,
    });
    expect(anomalyDetected).toBe(false);
  });

  it("handles zero stdDev gracefully", () => {
    const { anomalyDetected } = detectAutonomousAnomaly({
      ...BASE,
      historicalStdDev: 0,
      actionValue: 999_999,
    });
    expect(anomalyDetected).toBe(false);
  });
});
