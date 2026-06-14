import { describe, it, expect } from "vitest";
import {
  ACTION_CLASS_FAMILIES,
  CONDITION_TYPES,
  REASON_CODES,
  TAXONOMY_SCHEMA_VERSION,
  familyForSlug,
  getReasonCode,
  isActionClassFamilyId,
  isConditionTypeId,
  isReasonCode,
} from "../src/taxonomy.js";

describe("taxonomy registry", () => {
  it("exposes the canonical counts and a schema version", () => {
    expect(TAXONOMY_SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ACTION_CLASS_FAMILIES).toHaveLength(10);
    expect(CONDITION_TYPES).toHaveLength(26);
    expect(REASON_CODES).toHaveLength(31);
  });

  it("rolls a slug up to its family, and returns undefined when unmapped", () => {
    expect(familyForSlug("vendor.payment.release")).toBe("financial.transaction");
    expect(familyForSlug("production.deploy")).toBe("production.deploy");
    expect(familyForSlug("nope.unknown")).toBeUndefined();
  });

  it("looks up reason-code metadata", () => {
    const r = getReasonCode("SNAPSHOT_REQUIRED");
    expect(r?.severity).toBe("error");
    expect(r?.retryAdvice).toBe("with_modified_input");
    expect(getReasonCode("NOT_A_CODE")).toBeUndefined();
  });

  it("provides membership guards", () => {
    expect(isActionClassFamilyId("production.deploy")).toBe(true);
    expect(isActionClassFamilyId("nope.nope")).toBe(false);
    expect(isConditionTypeId("approval_required")).toBe(true);
    expect(isConditionTypeId("nope")).toBe(false);
    expect(isReasonCode("INSUFFICIENT_APPROVALS")).toBe(true);
    expect(isReasonCode("nope")).toBe(false);
  });

  it("is internally consistent: families → condition types → reason codes", () => {
    for (const f of ACTION_CLASS_FAMILIES) {
      for (const c of f.typicalConditions) {
        expect(isConditionTypeId(c), `family ${f.familyId} → unknown condition ${c}`).toBe(true);
      }
    }
    for (const c of CONDITION_TYPES) {
      for (const code of c.producesReasonCode) {
        expect(isReasonCode(code), `condition ${c.conditionId} → unknown reason ${code}`).toBe(true);
      }
    }
  });
});
