import { describe, expect, it } from "vitest";
import type { ApprovalArtifactV1, ApprovalReference } from "../src/approvalArtifact.js";

describe("ApprovalArtifactV1 type contract", () => {
  it("accepts a fully-populated artifact", () => {
    const artifact: ApprovalArtifactV1 = {
      version: "approval_artifact.v1",
      approval_id: "apr_123",
      tenant_id: "tnt_1",
      action_type: "deployment.production",
      resource_id: "release:abc123",
      action_hash: "f".repeat(64),
      reviewer: {
        principal_id: "okta|00u123",
        principal_kind: "human",
        email: "alice@example.com",
        roles: ["qa_reviewer"],
      },
      issuer: { type: "approval_service", issuer_id: "issuer.test", kid: "kid-1" },
      issued_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      nonce: "n_abcdef01",
      signature: "deadbeef",
    };
    expect(artifact.version).toBe("approval_artifact.v1");
    expect(artifact.reviewer.principal_kind).toBe("human");
  });

  it("supports approval_id-only reference (server-side resolution)", () => {
    const ref: ApprovalReference = { approval_id: "apr_123" };
    expect(ref.approval_id).toBe("apr_123");
  });

  it("re-exports the artifact types from the package entrypoint", async () => {
    const mod = await import("../src/index.js");
    // Type-only re-exports do not appear at runtime; this test just
    // proves the entrypoint loads with the new export wired in.
    expect(typeof mod).toBe("object");
  });
});
