import { describe, expect, it, vi } from "vitest";
import type { AtlaSentClient } from "@atlasent/sdk";
import {
  guardedGmailSend,
  guardedGmailSendDraft,
  computeExternalSendTargetId,
  GmailSendDeniedError,
  COMMUNICATION_EXTERNAL_SEND,
  type GmailExternalSendFacts,
} from "../src/index.js";

// ── fixtures ─────────────────────────────────────────────────────────────────

const BASE_FACTS: GmailExternalSendFacts = {
  recipient: "newcustomer@example.com",
  recipientKnown: false,
  sensitiveAttachment: true,
  attachmentSha256: "3b1c...deadbeef",
  approvals: 1,
  actorOrigin: "human",
};

const ALLOW_EVAL = {
  decision: "allow" as const,
  decision_canonical: "allow" as const,
  evaluationId: "eval-alpha",
  permitId: "permit-alpha",
  permit: null,
  permitToken: "pt.v3.alpha",
  reasons: [],
  reason: "",
  deny_code: null,
  auditHash: "hash-alpha",
  timestamp: "2026-08-09T00:00:00Z",
  rateLimit: null,
};

const DENY_EVAL = {
  ...ALLOW_EVAL,
  decision: "deny" as const,
  decision_canonical: "deny" as const,
  evaluationId: "eval-deny",
  reason: "policy denied",
  reasons: ["policy denied"],
  deny_code: "INSUFFICIENT_APPROVALS",
  auditHash: "hash-deny",
};

const HOLD_EVAL = {
  ...ALLOW_EVAL,
  decision: "hold" as const,
  decision_canonical: "hold" as const,
  evaluationId: "eval-hold",
  reason: "awaiting reviewer",
  deny_code: null,
  auditHash: "hash-hold",
};

const VERIFY_OK = {
  verified: true,
  outcome: "verified",
  permitHash: "permit-hash-alpha",
  timestamp: "2026-08-09T00:00:01Z",
  expiresAt: null,
  rateLimit: null,
};

const VERIFY_MISMATCH = {
  verified: false,
  outcome: "PERMIT_BINDING_MISMATCH",
  permitHash: "permit-hash-alpha",
  timestamp: "2026-08-09T00:00:01Z",
  expiresAt: null,
  rateLimit: null,
};

function makeClient(overrides: Partial<AtlaSentClient> = {}): AtlaSentClient {
  return {
    evaluate: vi.fn(async () => ALLOW_EVAL),
    verifyPermit: vi.fn(async () => VERIFY_OK),
    ...overrides,
  } as unknown as AtlaSentClient;
}

function makeGmail() {
  return {
    users: {
      messages: {
        send: vi.fn(async () => ({ data: { id: "msg-1", threadId: "thread-1" } })),
      },
      drafts: {
        send: vi.fn(async () => ({ data: { id: "msg-draft-1" } })),
      },
    },
  };
}

// ── guardedGmailSend ─────────────────────────────────────────────────────────

describe("guardedGmailSend", () => {
  it("sends when evaluate returns allow and verify succeeds", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient();
    const result = await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: { raw: "encoded" } },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    expect(result.sent).toBe(true);
    if (result.sent) {
      expect(result.message).toEqual({ id: "msg-1", threadId: "thread-1" });
      expect(result.permitId).toBe("permit-alpha");
      expect(result.auditHash).toBe("hash-alpha");
    }
    expect(gmail.users.messages.send).toHaveBeenCalledTimes(1);
  });

  it("calls evaluate with the canonical action_type and derived context", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient();
    await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: {} },
      BASE_FACTS,
      { agent: "user:sales-rep-01", environment: "test" },
    );
    expect(atlasent.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: "user:sales-rep-01",
        action_type: COMMUNICATION_EXTERNAL_SEND,
        environment: "test",
        context: expect.objectContaining({
          recipient_known: false,
          sensitive_attachment: true,
          approvals: 1,
          recipient_domain: "example.com",
          actor_origin: "human",
          target: { id: await computeExternalSendTargetId(BASE_FACTS) },
        }),
      }),
    );
  });

  it("verifies via execution_hash, not context (context is ignored by the server)", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient();
    await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: {} },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    const call = (atlasent.verifyPermit as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call).toMatchObject({
      permitId: "permit-alpha",
      agent: "user:sales-rep-01",
      action: COMMUNICATION_EXTERNAL_SEND,
      environment: "production",
    });
    // AtlaSentClient.verifyPermit does not consult `context` at all — the
    // only binding channel is execution_hash. A regression that goes back
    // to sending `context` instead would leave verify unbound in
    // production and must fail this test.
    expect(call.context).toBeUndefined();
    expect(call.execution_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("execution_hash changes when the exact-binding facts change (same exact-binding sensitivity as target-id)", async () => {
    const gmail = makeGmail();
    const atlasentA = makeClient();
    await guardedGmailSend(
      gmail as never,
      atlasentA,
      { userId: "me", requestBody: {} },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    const hashA = (atlasentA.verifyPermit as ReturnType<typeof vi.fn>).mock.calls[0][0].execution_hash;

    const gmail2 = makeGmail();
    const atlasentB = makeClient();
    await guardedGmailSend(
      gmail2 as never,
      atlasentB,
      { userId: "me", requestBody: {} },
      { ...BASE_FACTS, recipient: "swapped-recipient@example.com" },
      { agent: "user:sales-rep-01" },
    );
    const hashB = (atlasentB.verifyPermit as ReturnType<typeof vi.fn>).mock.calls[0][0].execution_hash;

    expect(hashA).not.toBe(hashB);
  });

  // The single most important test: on a DENY, the real Gmail send call
  // must never be made.
  it("NEVER calls the real Gmail send on a deny decision", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const result = await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: {} },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.decision).toBe("deny");
      expect(result.denyCode).toBe("INSUFFICIENT_APPROVALS");
      expect(result.reason).toBe("policy denied");
    }
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
    expect(atlasent.verifyPermit).not.toHaveBeenCalled();
  });

  it("NEVER calls the real Gmail send on a hold decision", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient({ evaluate: vi.fn(async () => HOLD_EVAL) });
    const result = await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: {} },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    expect(result.sent).toBe(false);
    if (!result.sent) expect(result.decision).toBe("hold");
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
  });

  it("fails closed and never sends when evaluate throws a network error", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient({
      evaluate: vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    const result = await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: {} },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.decision).toBe("error");
      expect(result.reason).toContain("ECONNRESET");
    }
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
  });

  it("fails closed and never sends when verifyPermit throws a network error", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient({
      verifyPermit: vi.fn(async () => {
        throw new Error("timeout");
      }),
    });
    const result = await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: {} },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.decision).toBe("error");
      expect(result.reason).toContain("timeout");
    }
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
  });

  // Simulates a permit-mismatch-on-retry: the request is re-presented with
  // mutated facts (e.g. a swapped recipient after approval), so the
  // target-id hash no longer matches what the runtime bound at evaluate
  // time. The runtime's generic exact-binding refuses this at verify with
  // PERMIT_BINDING_MISMATCH — the wrapper must never send in that case.
  it("fails closed on a permit binding mismatch (mutated facts / replay) and never sends", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient({ verifyPermit: vi.fn(async () => VERIFY_MISMATCH) });
    const result = await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: {} },
      { ...BASE_FACTS, recipient: "attacker@evil.example" },
      { agent: "user:sales-rep-01" },
    );
    expect(result.sent).toBe(false);
    if (!result.sent) {
      expect(result.decision).toBe("verify_failed");
      expect(result.reason).toContain("PERMIT_BINDING_MISMATCH");
    }
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
  });

  it("throws GmailSendDeniedError instead of returning a result when onDeny is 'throw'", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    await expect(
      guardedGmailSend(
        gmail as never,
        atlasent,
        { userId: "me", requestBody: {} },
        BASE_FACTS,
        { agent: "user:sales-rep-01", onDeny: "throw" },
      ),
    ).rejects.toBeInstanceOf(GmailSendDeniedError);
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
  });

  it("AI-agent-originated send is denied identically to a human-originated send on the same shortfall", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const result = await guardedGmailSend(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: {} },
      { ...BASE_FACTS, actorOrigin: "ai_agent", approvals: 0 },
      { agent: "agent:outreach-assistant" },
    );
    expect(result.sent).toBe(false);
    expect(gmail.users.messages.send).not.toHaveBeenCalled();
  });
});

// ── guardedGmailSendDraft ────────────────────────────────────────────────────

describe("guardedGmailSendDraft", () => {
  it("sends the draft only after allow + verified", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient();
    const result = await guardedGmailSendDraft(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: { id: "draft-1" } },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    expect(result.sent).toBe(true);
    expect(gmail.users.drafts.send).toHaveBeenCalledTimes(1);
  });

  it("never sends the draft on deny", async () => {
    const gmail = makeGmail();
    const atlasent = makeClient({ evaluate: vi.fn(async () => DENY_EVAL) });
    const result = await guardedGmailSendDraft(
      gmail as never,
      atlasent,
      { userId: "me", requestBody: { id: "draft-1" } },
      BASE_FACTS,
      { agent: "user:sales-rep-01" },
    );
    expect(result.sent).toBe(false);
    expect(gmail.users.drafts.send).not.toHaveBeenCalled();
  });
});

// ── computeExternalSendTargetId ──────────────────────────────────────────────

describe("computeExternalSendTargetId", () => {
  it("is deterministic for identical facts", async () => {
    const a = await computeExternalSendTargetId(BASE_FACTS);
    const b = await computeExternalSendTargetId({ ...BASE_FACTS });
    expect(a).toBe(b);
  });

  it("changes when the recipient is mutated (exact-binding sensitivity)", async () => {
    const a = await computeExternalSendTargetId(BASE_FACTS);
    const b = await computeExternalSendTargetId({ ...BASE_FACTS, recipient: "attacker@evil.example" });
    expect(a).not.toBe(b);
  });

  it("changes when the attachment hash is mutated", async () => {
    const a = await computeExternalSendTargetId(BASE_FACTS);
    const b = await computeExternalSendTargetId({ ...BASE_FACTS, attachmentSha256: "aaaa...swapped-file" });
    expect(a).not.toBe(b);
  });

  it("changes when the sensitivity flag is downgraded", async () => {
    const a = await computeExternalSendTargetId(BASE_FACTS);
    const b = await computeExternalSendTargetId({ ...BASE_FACTS, sensitiveAttachment: false });
    expect(a).not.toBe(b);
  });

  it("is a 64-char lowercase hex SHA-256 digest", async () => {
    const hash = await computeExternalSendTargetId(BASE_FACTS);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
