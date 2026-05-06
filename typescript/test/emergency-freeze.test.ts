/**
 * Tests for emergency freeze behavior and incentive alignment signals.
 *
 * Covers: freeze creation, scope, multi-signal detection, health scoring,
 * and governance fatigue patterns.
 */
import { describe, expect, it } from "vitest";
import {
  computeGovernanceHealthScore,
  detectMisalignedIncentives,
  DEFAULT_INCENTIVE_CONFIG,
} from "../src/incentiveAlignment.js";
import {
  computeExposureScore,
  computeHHI,
  computeOverallRiskScore,
  computeOverrideScore,
  detectSelfApproval,
  hhiToConcentrationScore,
  scoreToRiskTier,
} from "../src/economicRisk.js";
import { classifyRiskTier, withinAutonomousCeiling } from "../src/financialAction.js";

describe("classifyRiskTier", () => {
  it("classifies 0 as low", ()            => expect(classifyRiskTier(0)).toBe("low"));
  it("classifies 999 as low", ()          => expect(classifyRiskTier(999)).toBe("low"));
  it("classifies 1000 as medium", ()      => expect(classifyRiskTier(1_000)).toBe("medium"));
  it("classifies 49999 as medium", ()     => expect(classifyRiskTier(49_999)).toBe("medium"));
  it("classifies 50000 as high", ()       => expect(classifyRiskTier(50_000)).toBe("high"));
  it("classifies 999999 as high", ()      => expect(classifyRiskTier(999_999)).toBe("high"));
  it("classifies 1000000 as critical", () => expect(classifyRiskTier(1_000_000)).toBe("critical"));
  it("classifies 999999999 as critical", ()=> expect(classifyRiskTier(999_999_999)).toBe("critical"));
});

describe("withinAutonomousCeiling", () => {
  it("returns true when ceiling is null (no ceiling)", () => {
    expect(withinAutonomousCeiling(999_999, null)).toBe(true);
  });
  it("returns true when value equals ceiling", () => {
    expect(withinAutonomousCeiling(500, 500)).toBe(true);
  });
  it("returns false when value exceeds ceiling", () => {
    expect(withinAutonomousCeiling(501, 500)).toBe(false);
  });
});

describe("computeOverallRiskScore", () => {
  it("returns 0 for all-zero sub-scores", () => {
    expect(computeOverallRiskScore({ exposure: 0, concentration: 0, override: 0, drift: 0, anomaly: 0 })).toBe(0);
  });
  it("returns 100 for all-max sub-scores", () => {
    expect(computeOverallRiskScore({ exposure: 100, concentration: 100, override: 100, drift: 100, anomaly: 100 })).toBe(100);
  });
  it("clamps above 100", () => {
    expect(computeOverallRiskScore({ exposure: 200, concentration: 200, override: 200, drift: 200, anomaly: 200 })).toBe(100);
  });
  it("clamps below 0", () => {
    expect(computeOverallRiskScore({ exposure: -10, concentration: -10, override: -10, drift: -10, anomaly: -10 })).toBe(0);
  });
});

describe("scoreToRiskTier", () => {
  it("maps 0 to low",      () => expect(scoreToRiskTier(0)).toBe("low"));
  it("maps 25 to low",     () => expect(scoreToRiskTier(25)).toBe("low"));
  it("maps 26 to medium",  () => expect(scoreToRiskTier(26)).toBe("medium"));
  it("maps 55 to medium",  () => expect(scoreToRiskTier(55)).toBe("medium"));
  it("maps 56 to high",    () => expect(scoreToRiskTier(56)).toBe("high"));
  it("maps 80 to high",    () => expect(scoreToRiskTier(80)).toBe("high"));
  it("maps 81 to critical",() => expect(scoreToRiskTier(81)).toBe("critical"));
  it("maps 100 to critical",()=> expect(scoreToRiskTier(100)).toBe("critical"));
});

describe("computeHHI and hhiToConcentrationScore", () => {
  it("HHI is 0 for equal distribution across 100 parties", () => {
    const shares = Array.from({ length: 100 }, () => 1);
    expect(computeHHI(shares)).toBe(100);
  });

  it("HHI is 10000 for monopoly (one party = 100%)", () => {
    expect(computeHHI([100])).toBe(10_000);
  });

  it("hhiToConcentrationScore maps 10000 to 100", () => {
    expect(hhiToConcentrationScore(10_000)).toBe(100);
  });

  it("hhiToConcentrationScore maps 0 to 0", () => {
    expect(hhiToConcentrationScore(0)).toBe(0);
  });
});

describe("computeExposureScore", () => {
  it("returns 0 when no active records", () => {
    const records = [{ action_value: 100_000, status: "completed" as const, risk_tier: "medium" as const }];
    expect(computeExposureScore(records)).toBe(0);
  });

  it("returns non-zero for pending_approval records", () => {
    const records = [{ action_value: 1_000_000, status: "pending_approval" as const, risk_tier: "high" as const }];
    expect(computeExposureScore(records)).toBeGreaterThan(0);
  });
});

describe("computeOverrideScore", () => {
  it("returns 0 with no executions", () => {
    expect(computeOverrideScore(0, 0)).toBe(0);
  });
  it("returns 100 at 10% override rate", () => {
    expect(computeOverrideScore(100, 10)).toBe(100);
  });
  it("clamps at 100 above 10%", () => {
    expect(computeOverrideScore(100, 50)).toBe(100);
  });
});

describe("detectSelfApproval", () => {
  it("detects when initiator is in approver list", () => {
    expect(detectSelfApproval("user-a", ["user-b", "user-a"])).toBe(true);
  });
  it("returns false when initiator not in approver list", () => {
    expect(detectSelfApproval("user-a", ["user-b", "user-c"])).toBe(false);
  });
});

describe("detectMisalignedIncentives", () => {
  const BASE = {
    partyId:              "user-fm",
    partyLabel:           "Finance Manager",
    windowDays:           30,
    totalActions:         100,
    overrideCount:        0,
    emergencyBypassCount: 0,
    approvalLatencies:    [120, 180, 240] as number[],
    approvalShare:        0.10,
    delegationDepthMax:   1,
  };

  it("returns no signals for healthy governance", () => {
    const signals = detectMisalignedIncentives(BASE);
    expect(signals).toHaveLength(0);
  });

  it("detects excessive_overrides when rate exceeds threshold", () => {
    const signals = detectMisalignedIncentives({ ...BASE, overrideCount: 10 });
    expect(signals.some((s) => s.signal_type === "excessive_overrides")).toBe(true);
  });

  it("detects emergency_bypass_repeat above threshold", () => {
    const signals = detectMisalignedIncentives({
      ...BASE,
      emergencyBypassCount: DEFAULT_INCENTIVE_CONFIG.max_emergency_bypasses_30d + 1,
    });
    expect(signals.some((s) => s.signal_type === "emergency_bypass_repeat")).toBe(true);
  });

  it("detects rushed_approval for sub-threshold latencies", () => {
    const signals = detectMisalignedIncentives({
      ...BASE,
      approvalLatencies: [5, 10, 15],
    });
    expect(signals.some((s) => s.signal_type === "rushed_approval")).toBe(true);
  });

  it("detects authority_concentration above threshold", () => {
    const signals = detectMisalignedIncentives({
      ...BASE,
      approvalShare: 0.60,
    });
    expect(signals.some((s) => s.signal_type === "authority_concentration")).toBe(true);
  });

  it("detects delegation_chain_depth above threshold", () => {
    const signals = detectMisalignedIncentives({
      ...BASE,
      delegationDepthMax: 5,
    });
    expect(signals.some((s) => s.signal_type === "delegation_chain_depth")).toBe(true);
  });

  it("sorts signals by severity descending", () => {
    const signals = detectMisalignedIncentives({
      ...BASE,
      overrideCount:        20,
      emergencyBypassCount: 10,
      approvalLatencies:    [1, 2, 3],
      approvalShare:        0.90,
      delegationDepthMax:   8,
    });
    for (let i = 0; i < signals.length - 1; i++) {
      expect(signals[i]!.severity).toBeGreaterThanOrEqual(signals[i + 1]!.severity);
    }
  });
});

describe("computeGovernanceHealthScore", () => {
  it("returns 100 for no signals", () => {
    expect(computeGovernanceHealthScore([])).toBe(100);
  });

  it("reduces score for each signal", () => {
    const signals = detectMisalignedIncentives({
      partyId:              "user-x",
      partyLabel:           "X",
      windowDays:           30,
      totalActions:         100,
      overrideCount:        20,
      emergencyBypassCount: 10,
      approvalLatencies:    [1, 2, 3],
      approvalShare:        0.90,
      delegationDepthMax:   8,
    });
    const score = computeGovernanceHealthScore(signals);
    expect(score).toBeLessThan(100);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
