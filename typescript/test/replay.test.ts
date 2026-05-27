/**
 * Tests for verifyEvidenceBundle — Phase 3 offline replay client.
 *
 * These cover the structural + hash-integrity checks for evidence bundles
 * downloaded from GET /v1/evidence-bundles/:id. Network-free; no AtlaSentClient.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  type EvidenceBundleVerifyResult,
  type OfflineEvidenceBundleData,
  _computeEvidenceRootHash,
  verifyEvidenceBundle,
} from "../src/replay.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBundle(
  overrides: Partial<OfflineEvidenceBundleData> = {},
): OfflineEvidenceBundleData {
  return {
    bundle_id: "bnd_test123",
    org_id: "org_abc",
    status: "ready",
    permits: [{ permit_id: "prm_001", evaluation_id: "eval_001" }],
    ...overrides,
  };
}

function bundleWithHashChain(
  permits?: OfflineEvidenceBundleData["permits"],
): OfflineEvidenceBundleData {
  const p = permits ?? [{ permit_id: "prm_001", evaluation_id: "eval_001" }];
  const root = _computeEvidenceRootHash(p);
  return {
    bundle_id: "bnd_hashed",
    org_id: "org_abc",
    status: "ready",
    permits: p,
    hash_chain: { root_hash: root, entry_count: p.length },
  };
}

// ── Basic validation ──────────────────────────────────────────────────────────

describe("verifyEvidenceBundle — basic validation", () => {
  it("returns valid=true for a well-formed ready bundle", () => {
    const result = verifyEvidenceBundle(makeBundle());
    expect(result.valid).toBe(true);
    expect(result.bundleId).toBe("bnd_test123");
    expect(result.permitId).toBe("prm_001");
    expect(result.reason).toBeUndefined();
  });

  it("returns an EvidenceBundleVerifyResult object", () => {
    const result = verifyEvidenceBundle(makeBundle());
    const keys: (keyof EvidenceBundleVerifyResult)[] = [
      "valid",
      "bundleId",
      "permitId",
      "reason",
    ];
    for (const k of keys) {
      expect(k in result).toBe(true);
    }
  });

  it("returns valid=false for a null/undefined input", () => {
    // @ts-expect-error — deliberate bad input for runtime guard test
    const result = verifyEvidenceBundle(null);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/non-null object/);
  });

  it("returns valid=false for an array input", () => {
    // @ts-expect-error — deliberate bad input
    const result = verifyEvidenceBundle([{ bundle_id: "x" }]);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/non-null object/);
  });
});

// ── Missing required fields ───────────────────────────────────────────────────

describe("verifyEvidenceBundle — missing required fields", () => {
  it.each(["bundle_id", "org_id", "status"] as const)(
    "returns valid=false when '%s' is missing",
    (field) => {
      const bundle = makeBundle();
      delete bundle[field];
      const result = verifyEvidenceBundle(bundle);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe(`missing required field: ${field}`);
    },
  );

  it("returns bundleId=undefined when bundle_id is missing", () => {
    const bundle = makeBundle();
    delete bundle.bundle_id;
    const result = verifyEvidenceBundle(bundle);
    expect(result.bundleId).toBeUndefined();
  });

  it("preserves bundleId when org_id is missing", () => {
    const bundle = makeBundle();
    delete bundle.org_id;
    const result = verifyEvidenceBundle(bundle);
    expect(result.bundleId).toBe("bnd_test123");
  });
});

// ── Status checks ─────────────────────────────────────────────────────────────

describe("verifyEvidenceBundle — status checks", () => {
  it.each(["generating", "failed", "pending", "building"])(
    "returns valid=false for status='%s'",
    (status) => {
      const result = verifyEvidenceBundle(makeBundle({ status }));
      expect(result.valid).toBe(false);
      expect(result.reason).toContain(`bundle status is '${status}'`);
      expect(result.reason).toContain("expected 'ready'");
    },
  );

  it("returns valid=true for status='ready'", () => {
    const result = verifyEvidenceBundle(makeBundle({ status: "ready" }));
    expect(result.valid).toBe(true);
  });
});

// ── Hash chain verification ───────────────────────────────────────────────────

describe("verifyEvidenceBundle — hash chain", () => {
  it("passes with a correct hash_chain", () => {
    const result = verifyEvidenceBundle(bundleWithHashChain());
    expect(result.valid).toBe(true);
  });

  it("returns valid=false when root_hash does not match", () => {
    const bundle = bundleWithHashChain();
    bundle.hash_chain!.root_hash = "deadbeef".repeat(8);
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/root hash mismatch/);
  });

  it("skips hash check when hash_chain is absent", () => {
    const bundle = makeBundle();
    expect(bundle.hash_chain).toBeUndefined();
    const result = verifyEvidenceBundle(bundle);
    expect(result.valid).toBe(true);
  });

  it("skips hash check when hash_chain has no root_hash key", () => {
    const bundle = makeBundle({ hash_chain: { entry_count: 1 } });
    const result = verifyEvidenceBundle(bundle);
    // root_hash is undefined → check is skipped
    expect(result.valid).toBe(true);
  });

  it("handles multiple permits in hash_chain correctly", () => {
    const permits = [
      { permit_id: "prm_001", evaluation_id: "eval_001" },
      { permit_id: "prm_002", evaluation_id: "eval_002" },
    ];
    const result = verifyEvidenceBundle(bundleWithHashChain(permits));
    expect(result.valid).toBe(true);
    expect(result.permitId).toBe("prm_001");
  });
});

// ── Permit extraction ─────────────────────────────────────────────────────────

describe("verifyEvidenceBundle — permit extraction", () => {
  it("returns the first permit_id", () => {
    const result = verifyEvidenceBundle(makeBundle());
    expect(result.permitId).toBe("prm_001");
  });

  it("returns permitId=undefined for an empty permits array", () => {
    const result = verifyEvidenceBundle(makeBundle({ permits: [] }));
    expect(result.permitId).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("returns permitId=undefined when permit has no permit_id key", () => {
    const result = verifyEvidenceBundle(
      makeBundle({ permits: [{ evaluation_id: "eval_001" }] }),
    );
    expect(result.permitId).toBeUndefined();
    expect(result.valid).toBe(true);
  });

  it("returns permitId=undefined when permits key is absent", () => {
    const bundle: OfflineEvidenceBundleData = {
      bundle_id: "bnd_test",
      org_id: "org_abc",
      status: "ready",
    };
    const result = verifyEvidenceBundle(bundle);
    expect(result.permitId).toBeUndefined();
    expect(result.valid).toBe(true);
  });
});

// ── _computeEvidenceRootHash ──────────────────────────────────────────────────

describe("_computeEvidenceRootHash", () => {
  it("is deterministic", () => {
    const permits = [{ permit_id: "a" }, { permit_id: "b" }];
    expect(_computeEvidenceRootHash(permits)).toBe(
      _computeEvidenceRootHash(permits),
    );
  });

  it("returns a 64-char hex SHA-256 string", () => {
    const result = _computeEvidenceRootHash([]);
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });

  it("matches manual SHA-256 of canonical JSON", () => {
    const permits = [{ permit_id: "prm_001", evaluation_id: "eval_001" }];
    const canonical = JSON.stringify(permits, (_, value) => {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        );
      }
      return value;
    });
    const expected = createHash("sha256").update(canonical).digest("hex");
    expect(_computeEvidenceRootHash(permits)).toBe(expected);
  });

  it("sorts object keys canonically", () => {
    const p1 = [{ b: 2, a: 1 }];
    const p2 = [{ a: 1, b: 2 }];
    expect(_computeEvidenceRootHash(p1 as never)).toBe(
      _computeEvidenceRootHash(p2 as never),
    );
  });

  it("handles undefined/null input as empty array", () => {
    const result = _computeEvidenceRootHash(undefined);
    const expected = _computeEvidenceRootHash([]);
    expect(result).toBe(expected);
  });
});
