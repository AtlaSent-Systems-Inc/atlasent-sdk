import { describe, it, expect } from "vitest";
import { DENY_CODES, isHumanApprovalRequired } from "../src/index.js";

describe("deny codes", () => {
  it("exposes HUMAN_APPROVAL_REQUIRED", () => {
    expect(DENY_CODES.HUMAN_APPROVAL_REQUIRED).toBe("HUMAN_APPROVAL_REQUIRED");
  });

  it("isHumanApprovalRequired accepts a raw code", () => {
    expect(isHumanApprovalRequired("HUMAN_APPROVAL_REQUIRED")).toBe(true);
    expect(isHumanApprovalRequired(DENY_CODES.HUMAN_APPROVAL_REQUIRED)).toBe(true);
    expect(isHumanApprovalRequired("SNAPSHOT_REQUIRED")).toBe(false);
    expect(isHumanApprovalRequired(null)).toBe(false);
    expect(isHumanApprovalRequired(undefined)).toBe(false);
  });

  it("isHumanApprovalRequired accepts an object carrying deny_code", () => {
    expect(isHumanApprovalRequired({ deny_code: "HUMAN_APPROVAL_REQUIRED" })).toBe(true);
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
