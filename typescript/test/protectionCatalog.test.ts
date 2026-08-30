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
    // source_manifest is intentionally reduced to a single entry in this public
    // mirror (see .atlasent-protection-catalog-pin.json's deviation field) —
    // the canonical repo's full manifest is not published here.
    expect(catalog.generation_provenance.source_manifest).toHaveLength(1);
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

  it("rejects pack status that disagrees with maturity and version history", () => {
    const candidate = structuredClone(catalogFixture);
    candidate.action_packs[0].status = "active";
    expect(ProtectionCatalogSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a SemVer numeric prerelease identifier with a leading zero", () => {
    const candidate = structuredClone(catalogFixture);
    candidate.action_packs[0].version = "1.0.0-01";
    candidate.action_packs[0].version_history[0].version = "1.0.0-01";
    expect(ProtectionCatalogSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects a customer-accepted boundary without L4/L5 exact-scope proof", () => {
    const candidate = structuredClone(catalogFixture);
    candidate.action_packs[0].binding_profiles[0].boundary_status = "customer_accepted";
    expect(ProtectionCatalogSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects GA maturity when any binding profile remains below production proof", () => {
    const candidate = structuredClone(catalogFixture);
    const pack = candidate.action_packs[0];
    const profile = pack.binding_profiles[0];
    const action = pack.actions[0];
    const evidenceRef = pack.source_refs[0];
    const exactScopeEvidence = {
      evidence_refs: [evidenceRef],
      evidence_cutoff: "2026-08-28",
      exact_scope: {
        action_refs: [{ canon_id: action.canon_id, act_id: action.act_id, slug: action.slug }],
        system_binding_profile_refs: [profile.system_binding_profile_id],
        environments: ["production"],
        resource_scope_refs: [evidenceRef],
      },
    };

    pack.maturity.surface_tier = "GA";
    pack.maturity.implementation_status = "runtime_integrated";
    pack.maturity.proof_rung = "production_validated";
    pack.maturity.proof_evidence_refs = [evidenceRef];
    pack.maturity.proof_evidence_cutoff = "2026-08-28";
    pack.maturity.customer_acceptance = "accepted";
    pack.maturity.customer_acceptance_evidence = exactScopeEvidence;

    expect(ProtectionCatalogSchema.safeParse(candidate).success).toBe(false);
  });

  it.each([
    ["catalog_version", "1.0.0"],
    ["released_at", "2026-08-28"],
    ["evidence_cutoff", "not-a-date"],
  ])("rejects an invalid %s release field", (field, value) => {
    const candidate = structuredClone(catalogFixture);
    candidate[field] = value;
    expect(ProtectionCatalogSchema.safeParse(candidate).success).toBe(false);
  });
});
