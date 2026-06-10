import { describe, expect, it, vi } from "vitest";

import { makeSmsOtpClient } from "../src/smsOtp.js";

function makeMocks() {
  const postFn = vi.fn();
  const client = makeSmsOtpClient(postFn as never);
  return { client, postFn };
}

// ── send ──────────────────────────────────────────────────────────────────────

describe("smsOtp.send", () => {
  const WIRE_SEND_RESPONSE = {
    otp_id: "otp_abc123",
    expires_at: "2026-06-10T12:05:00Z",
  };

  it("POSTs to /v1-sms-otp/send with correct body", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_SEND_RESPONSE });
    await client.send({ phone_e164: "+15551234567", action_context: "break_glass" });
    expect(postFn).toHaveBeenCalledWith("/v1-sms-otp/send", {
      phone_e164: "+15551234567",
      action_context: "break_glass",
    });
  });

  it("returns otp_id and expires_at from wire response", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_SEND_RESPONSE });
    const result = await client.send({
      phone_e164: "+15551234567",
      action_context: "break_glass",
    });
    expect(result.otp_id).toBe("otp_abc123");
    expect(result.expires_at).toBe("2026-06-10T12:05:00Z");
  });

  it("supports action_context=api_key_create", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_SEND_RESPONSE });
    await client.send({ phone_e164: "+15559876543", action_context: "api_key_create" });
    expect(postFn.mock.calls[0]![1]).toMatchObject({
      action_context: "api_key_create",
    });
  });

  it("supports action_context=governance_hold_approve", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_SEND_RESPONSE });
    await client.send({
      phone_e164: "+15550001111",
      action_context: "governance_hold_approve",
    });
    expect(postFn.mock.calls[0]![1]).toMatchObject({
      action_context: "governance_hold_approve",
    });
  });

  it("forwards the phone_e164 verbatim", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: WIRE_SEND_RESPONSE });
    await client.send({ phone_e164: "+447911123456", action_context: "break_glass" });
    expect(postFn.mock.calls[0]![1]).toMatchObject({ phone_e164: "+447911123456" });
  });
});

// ── verify ────────────────────────────────────────────────────────────────────

describe("smsOtp.verify", () => {
  it("POSTs to /v1-sms-otp/verify with correct body", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { valid: true } });
    await client.verify({ otp_id: "otp_abc123", code: "123456" });
    expect(postFn).toHaveBeenCalledWith("/v1-sms-otp/verify", {
      otp_id: "otp_abc123",
      code: "123456",
    });
  });

  it("returns valid=true when code matches", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { valid: true } });
    const result = await client.verify({ otp_id: "otp_abc123", code: "123456" });
    expect(result.valid).toBe(true);
  });

  it("returns valid=false when code does not match", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { valid: false } });
    const result = await client.verify({ otp_id: "otp_abc123", code: "000000" });
    expect(result.valid).toBe(false);
  });

  it("forwards otp_id verbatim", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { valid: true } });
    await client.verify({ otp_id: "otp_xyz789", code: "654321" });
    expect(postFn.mock.calls[0]![1]).toMatchObject({ otp_id: "otp_xyz789" });
  });

  it("forwards code verbatim", async () => {
    const { client, postFn } = makeMocks();
    postFn.mockResolvedValue({ body: { valid: false } });
    await client.verify({ otp_id: "otp_abc", code: "999888" });
    expect(postFn.mock.calls[0]![1]).toMatchObject({ code: "999888" });
  });
});
