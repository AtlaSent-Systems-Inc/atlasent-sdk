import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  FutureCapabilitySchema,
  ProtectionCatalogSchema,
  parseProtectionCatalog,
} from "../src/protectionCatalog.js";

const catalogPath = fileURLToPath(
  new URL("../../vendor/atlasent-canonical/protection-catalog/v1/catalog.json", import.meta.url),
);
const catalogFixture = JSON.parse(readFileSync(catalogPath, "utf8"));

describe("ProtectionCatalogSchema", () => {
  it("parses the byte-pinned canonical catalog", () => {
    const catalog = parseProtectionCatalog(catalogFixture);
    expect(catalog.actions).toHaveLength(54);
    expect(catalog.action_packs).toHaveLength(2);
    expect(catalog.future_capabilities).toHaveLength(15);
    expect(catalog.generation_provenance.source_manifest).toHaveLength(77);
  });

  it("preserves the exact rollback identity", () => {
    const catalog = parseProtectionCatalog(catalogFixture);
    const rollback = catalog.actions.find((action) => action.slug === "production.rollback");
    expect(rollback).toMatchObject({
      canon_id: "CANON-000031",
      act_id: "ACT-0034",
      slug: "production.rollback",
    });
  });

  it("records accepted substrate states without creating availability", () => {
    const catalog = parseProtectionCatalog(catalogFixture);
    const future = Object.fromEntries(
      catalog.future_capabilities.map((capability) => [capability.capability_id, capability]),
    );
    expect(future["EXP-1"]).toMatchObject({ contract_state: "accepted", build_state: "schema_implemented" });
    expect(future["LRN-1"]).toMatchObject({ contract_state: "accepted", build_state: "schema_implemented" });
    expect(future["OAS-1"]).toMatchObject({ contract_state: "accepted", build_state: "implementation_deferred" });
    for (const capability of catalog.future_capabilities) {
      expect(Object.values(capability.flags)).toEqual([false, false, false, false, false, false]);
    }
  });

  it("rejects any attempt to make a future capability activatable", () => {
    const future = structuredClone(catalogFixture.future_capabilities[0]);
    future.flags.activatable = true;
    expect(FutureCapabilitySchema.safeParse(future).success).toBe(false);
  });

  it("rejects role-navigation authority", () => {
    const candidate = structuredClone(catalogFixture);
    candidate.actions[0].classification.role_terms_grant_authority = true;
    expect(ProtectionCatalogSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects unknown top-level fields rather than inventing SDK truth", () => {
    const candidate = { ...catalogFixture, production_ready: true };
    expect(ProtectionCatalogSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects summary counts that outrun the payload", () => {
    const candidate = structuredClone(catalogFixture);
    candidate.summary.active_canonical_action_count = 55;
    expect(ProtectionCatalogSchema.safeParse(candidate).success).toBe(false);
  });
});
