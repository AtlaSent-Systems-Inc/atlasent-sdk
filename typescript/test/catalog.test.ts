import { describe, it, expect } from "vitest";
import {
  ACTION_CATALOG,
  ACTION_SLUGS,
  getActionBySlug,
  getActionById,
  getActionByCanonId,
  listActions,
} from "../src/catalog.js";

describe("ACTION_CATALOG", () => {
  it("has 29 entries", () => {
    expect(Object.keys(ACTION_CATALOG)).toHaveLength(29);
  });

  it("all entries have valid IDs matching ACT-XXXX", () => {
    for (const entry of Object.values(ACTION_CATALOG)) {
      expect(entry.id).toMatch(/^ACT-\d{4}$/);
    }
  });

  it("all entries have a permanent canon_id matching CANON-NNNNNN", () => {
    for (const entry of Object.values(ACTION_CATALOG)) {
      expect(entry.canon_id).toMatch(/^CANON-\d{6}$/);
    }
  });

  it("all slugs are unique", () => {
    const slugs = Object.values(ACTION_CATALOG).map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("all IDs are unique", () => {
    const ids = Object.values(ACTION_CATALOG).map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all canon_ids are unique", () => {
    const canonIds = Object.values(ACTION_CATALOG).map((a) => a.canon_id);
    expect(new Set(canonIds).size).toBe(canonIds.length);
  });

  it("human-only patterns never have machineExecutable=true", () => {
    for (const entry of Object.values(ACTION_CATALOG)) {
      if (entry.authorization_pattern.type === "human-only") {
        expect(entry.authorization_pattern.machine_executable).toBe(false);
      }
    }
  });

  it("entries requiring human approval have machineExecutable=false", () => {
    for (const entry of Object.values(ACTION_CATALOG)) {
      if (entry.gate_flags.requires_human_approval) {
        expect(entry.authorization_pattern.machine_executable).toBe(false);
      }
    }
  });
});

describe("getActionBySlug", () => {
  it("finds production.deploy", () => {
    const action = getActionBySlug("production.deploy");
    expect(action?.id).toBe("ACT-0001");
  });

  it("returns undefined for unknown slugs", () => {
    expect(getActionBySlug("nonexistent.action")).toBeUndefined();
  });
});

describe("getActionById", () => {
  it("finds ACT-0020", () => {
    const action = getActionById("ACT-0020");
    expect(action?.slug).toBe("compliance.certify");
  });

  it("returns undefined for unknown IDs", () => {
    expect(getActionById("ACT-9999")).toBeUndefined();
  });
});

describe("getActionByCanonId", () => {
  it("finds CANON-000001 (production.deploy)", () => {
    const action = getActionByCanonId("CANON-000001");
    expect(action?.slug).toBe("production.deploy");
    expect(action?.id).toBe("ACT-0001");
  });

  it("returns undefined for unknown canon IDs", () => {
    expect(getActionByCanonId("CANON-999999")).toBeUndefined();
  });
});

describe("listActions", () => {
  it("returns 29 actions", () => {
    expect(listActions()).toHaveLength(29);
  });

  it("every entry has a non-empty slug", () => {
    for (const action of listActions()) {
      expect(action.slug.length).toBeGreaterThan(0);
    }
  });
});

describe("ACTION_SLUGS", () => {
  it("contains all 29 slugs", () => {
    expect(ACTION_SLUGS).toHaveLength(29);
    expect(ACTION_SLUGS).toContain("production.deploy");
    expect(ACTION_SLUGS).toContain("compliance.certify");
    expect(ACTION_SLUGS).toContain("model.promote");
    expect(ACTION_SLUGS).toContain("data.export");
    expect(ACTION_SLUGS).toContain("security.breakglass");
  });
});
