import { describe, expect, it, vi } from "vitest";

import { makeSmsOtpClient } from "../src/smsOtp.js";

const BASE_URL = "https://api.test";

function okJson(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

function makeMocks() {
  const fetchMock = vi.fn();
  const client = makeSmsOtpClient(BASE_URL, fetchMock as unknown as typeof fetch);
  return { client, fetchMock };
}

function call(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, opts] = fetchMock.mock.calls[0]! as [string, RequestInit & { headers: Record<string, string> }];
  return { url, opts, body: JSON.parse(opts.body as string) };
}

// ── send ──────────────────────────────────────────────────────────────────────

describe("smsOtp.send", () => {
  const WIRE_SEND_RESPONSE = {
    otp_id: "otp_abc123",
    expires_at: "2026-06-10T12:05:00Z",
  };

  it("POSTs to /v1-sms-otp/send with JWT bearer and correct body", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson(WIRE_SEND_RESPONSE));
    await client.send({ phone_e164: "+15551234567", action_context: "break_glass", sessionJwt: "jwt-123" });
    const { url, opts, body } = call(fetchMock);
    expect(url).toBe(`${BASE_URL}/v1-sms-otp/send`);
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer jwt-123");
    // sessionJwt travels in the Authorization header, never in the body.
    expect(body).toEqual({ phone_e164: "+15551234567", action_context: "break_glass" });
  });

  it("returns otp_id and expires_at from wire response", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson(WIRE_SEND_RESPONSE));
    const result = await client.send({
      phone_e164: "+15551234567",
      action_context: "break_glass",
      sessionJwt: "jwt-123",
    });
    expect(result.otp_id).toBe("otp_abc123");
    expect(result.expires_at).toBe("2026-06-10T12:05:00Z");
  });

  it("supports action_context=api_key_create", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson(WIRE_SEND_RESPONSE));
    await client.send({ phone_e164: "+15559876543", action_context: "api_key_create", sessionJwt: "jwt" });
    expect(call(fetchMock).body).toMatchObject({ action_context: "api_key_create" });
  });

  it("supports action_context=governance_hold_approve", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson(WIRE_SEND_RESPONSE));
    await client.send({ phone_e164: "+15550001111", action_context: "governance_hold_approve", sessionJwt: "jwt" });
    expect(call(fetchMock).body).toMatchObject({ action_context: "governance_hold_approve" });
  });

  it("forwards the phone_e164 verbatim", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson(WIRE_SEND_RESPONSE));
    await client.send({ phone_e164: "+447911123456", action_context: "break_glass", sessionJwt: "jwt" });
    expect(call(fetchMock).body).toMatchObject({ phone_e164: "+447911123456" });
  });

  it("throws when the response is not ok", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve("unauthorized") } as unknown as Response);
    await expect(
      client.send({ phone_e164: "+15551234567", action_context: "break_glass", sessionJwt: "bad" }),
    ).rejects.toThrow(/SMS OTP request failed: 401/);
  });
});

// ── verify ────────────────────────────────────────────────────────────────────

describe("smsOtp.verify", () => {
  it("POSTs to /v1-sms-otp/verify with JWT bearer and correct body", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson({ valid: true }));
    await client.verify({ otp_id: "otp_abc123", code: "123456", sessionJwt: "jwt-xyz" });
    const { url, opts, body } = call(fetchMock);
    expect(url).toBe(`${BASE_URL}/v1-sms-otp/verify`);
    expect(opts.headers.Authorization).toBe("Bearer jwt-xyz");
    expect(body).toEqual({ otp_id: "otp_abc123", code: "123456" });
  });

  it("returns valid=true when code matches", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson({ valid: true }));
    const result = await client.verify({ otp_id: "otp_abc123", code: "123456", sessionJwt: "jwt" });
    expect(result.valid).toBe(true);
  });

  it("returns valid=false when code does not match", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson({ valid: false }));
    const result = await client.verify({ otp_id: "otp_abc123", code: "000000", sessionJwt: "jwt" });
    expect(result.valid).toBe(false);
  });

  it("forwards otp_id verbatim", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson({ valid: true }));
    await client.verify({ otp_id: "otp_xyz789", code: "654321", sessionJwt: "jwt" });
    expect(call(fetchMock).body).toMatchObject({ otp_id: "otp_xyz789" });
  });

  it("forwards code verbatim", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue(okJson({ valid: false }));
    await client.verify({ otp_id: "otp_abc", code: "999888", sessionJwt: "jwt" });
    expect(call(fetchMock).body).toMatchObject({ code: "999888" });
  });

  it("throws when the response is not ok", async () => {
    const { client, fetchMock } = makeMocks();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") } as unknown as Response);
    await expect(
      client.verify({ otp_id: "otp_abc", code: "111111", sessionJwt: "jwt" }),
    ).rejects.toThrow(/SMS OTP request failed: 500/);
  });
});
