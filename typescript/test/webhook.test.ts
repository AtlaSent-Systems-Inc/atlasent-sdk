/**
 * Tests for verifyWebhook / assertWebhook HMAC-SHA256 helpers.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  assertWebhook,
  verifyWebhook,
  WebhookVerificationError,
} from "../src/webhook.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const SECRET = "whsec_test_super_secret_key_1234";
const PAYLOAD = JSON.stringify({ event: "permit.created", id: "permit_abc123" });

function makeSignature(payload: string, secret: string): string {
  const hex = createHmac("sha256", secret).update(payload).digest("hex");
  return `sha256=${hex}`;
}

const VALID_SIG = makeSignature(PAYLOAD, SECRET);

// ── verifyWebhook ─────────────────────────────────────────────────────────────

describe("verifyWebhook", () => {
  it("returns true for a valid signature", async () => {
    expect(await verifyWebhook(PAYLOAD, VALID_SIG, SECRET)).toBe(true);
  });

  it("returns false when the secret is wrong", async () => {
    expect(await verifyWebhook(PAYLOAD, VALID_SIG, "wrong-secret")).toBe(false);
  });

  it("returns false when the payload is tampered", async () => {
    const tampered = PAYLOAD + " ";
    expect(await verifyWebhook(tampered, VALID_SIG, SECRET)).toBe(false);
  });

  it("returns false for a malformed signature — no sha256= prefix, bare non-hex", async () => {
    expect(await verifyWebhook(PAYLOAD, "not-a-valid-sig", SECRET)).toBe(false);
  });

  it("returns false for an empty signature string", async () => {
    expect(await verifyWebhook(PAYLOAD, "", SECRET)).toBe(false);
  });

  it("returns false for a non-hex value after sha256= prefix", async () => {
    expect(await verifyWebhook(PAYLOAD, "sha256=gggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggggg", SECRET)).toBe(false);
  });

  it("returns false for a sha256= prefix with wrong length hex", async () => {
    expect(await verifyWebhook(PAYLOAD, "sha256=deadbeef", SECRET)).toBe(false);
  });

  it("accepts a bare hex digest (no sha256= prefix) when correct", async () => {
    const bareHex = createHmac("sha256", SECRET).update(PAYLOAD).digest("hex");
    expect(await verifyWebhook(PAYLOAD, bareHex, SECRET)).toBe(true);
  });

  it("is case-insensitive in the hex digest (mixed-case hex after sha256= prefix)", async () => {
    // Only uppercase the hex part — the prefix `sha256=` is case-sensitive per spec.
    const rawHex = createHmac("sha256", SECRET).update(PAYLOAD).digest("hex");
    const mixedCaseSig = `sha256=${rawHex.toUpperCase()}`;
    expect(await verifyWebhook(PAYLOAD, mixedCaseSig, SECRET)).toBe(true);
  });

  it("two identical calls produce the same result (timing-safe sanity)", async () => {
    const r1 = await verifyWebhook(PAYLOAD, VALID_SIG, SECRET);
    const r2 = await verifyWebhook(PAYLOAD, VALID_SIG, SECRET);
    expect(r1).toBe(r2);
  });
});

// ── assertWebhook ─────────────────────────────────────────────────────────────

describe("assertWebhook", () => {
  it("does not throw for a valid signature", async () => {
    await expect(assertWebhook(PAYLOAD, VALID_SIG, SECRET)).resolves.toBeUndefined();
  });

  it("throws WebhookVerificationError for an invalid signature", async () => {
    await expect(assertWebhook(PAYLOAD, VALID_SIG, "wrong-secret")).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it("thrown error has the correct name property", async () => {
    try {
      await assertWebhook(PAYLOAD, "sha256=bad", SECRET);
      expect.fail("Expected assertWebhook to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookVerificationError);
      expect((err as WebhookVerificationError).name).toBe("WebhookVerificationError");
    }
  });

  it("throws for tampered payload", async () => {
    await expect(assertWebhook(PAYLOAD + "X", VALID_SIG, SECRET)).rejects.toThrow(
      WebhookVerificationError,
    );
  });

  it("throws for empty signature", async () => {
    await expect(assertWebhook(PAYLOAD, "", SECRET)).rejects.toThrow(
      WebhookVerificationError,
    );
  });
});

// ── WebhookVerificationError ──────────────────────────────────────────────────

describe("WebhookVerificationError", () => {
  it("is an instance of Error", () => {
    const e = new WebhookVerificationError("bad sig");
    expect(e).toBeInstanceOf(Error);
  });

  it("preserves the message", () => {
    const e = new WebhookVerificationError("custom message");
    expect(e.message).toBe("custom message");
  });

  it("has name WebhookVerificationError", () => {
    const e = new WebhookVerificationError("x");
    expect(e.name).toBe("WebhookVerificationError");
  });
});
