import { describe, it, expect } from "vitest";
import { DENY_CODES, isHumanApprovalRequired } from "../src/index.js";

describe("deny codes", () => {
  it("exposes INSUFFICIENT_APPROVALS", () => {
    expect(DENY_CODES.INSUFFICIENT_APPROVALS).toBe("INSUFFICIENT_APPROVALS");
  });

  it("isHumanApprovalRequired accepts a raw code", () => {
    expect(isHumanApprovalRequired("INSUFFICIENT_APPROVALS")).toBe(true);
    expect(isHumanApprovalRequired(DENY_CODES.INSUFFICIENT_APPROVALS)).toBe(true);
    expect(isHumanApprovalRequired("SNAPSHOT_REQUIRED")).toBe(false);
    expect(isHumanApprovalRequired(null)).toBe(false);
    expect(isHumanApprovalRequired(undefined)).toBe(false);
  });

  it("isHumanApprovalRequired accepts an object carrying deny_code", () => {
    expect(isHumanApprovalRequired({ deny_code: "INSUFFICIENT_APPROVALS" })).toBe(true);
    expect(isHumanApprovalRequired({ deny_code: "NO_AUTHORITY" })).toBe(false);
    expect(isHumanApprovalRequired({ deny_code: null })).toBe(false);
    expect(isHumanApprovalRequired({})).toBe(false);
  });

  it("all documented codes are UPPER_SNAKE", () => {
    for (const code of Object.values(DENY_CODES)) {
      expect(code).toBe(code.toUpperCase());
      expect(code).not.toContain(" ");
    }
  });
});
