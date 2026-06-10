/**
 * SMS OTP sub-client — send and verify one-time passcodes for
 * session-level operations that require step-up authentication.
 *
 * Wire surface: /v1-sms-otp/* endpoints in atlasent-api.
 * Auth: JWT session only (not API key).
 *
 * Usage:
 *
 * ```ts
 * import { AtlaSentClient } from "@atlasent/sdk";
 *
 * const client = new AtlaSentClient({ apiKey: "..." });
 *
 * // Send an OTP before a break-glass operation
 * const { otp_id, expires_at } = await client.smsOtp.send({
 *   phone_e164: "+15551234567",
 *   action_context: "break_glass",
 * });
 *
 * // Verify the code the user entered
 * const { valid } = await client.smsOtp.verify({ otp_id, code: "123456" });
 * ```
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** The set of action contexts that can trigger an SMS OTP challenge. */
export type SmsOtpActionContext =
  | "break_glass"
  | "api_key_create"
  | "governance_hold_approve";

/** Request body for `smsOtp.send()`. */
export interface SmsOtpSendRequest {
  /** Destination phone number in E.164 format (e.g. `"+15551234567"`). */
  phone_e164: string;
  /** The high-privilege action being gated behind this OTP. */
  action_context: SmsOtpActionContext;
}

/** Response from `smsOtp.send()`. */
export interface SmsOtpSendResponse {
  /** Opaque identifier for this OTP challenge — pass to `verify()`. */
  otp_id: string;
  /** ISO-8601 timestamp when this OTP expires. */
  expires_at: string;
}

/** Request body for `smsOtp.verify()`. */
export interface SmsOtpVerifyRequest {
  /** The `otp_id` returned by `send()`. */
  otp_id: string;
  /** The code the user entered from their SMS. */
  code: string;
}

/** Response from `smsOtp.verify()`. */
export interface SmsOtpVerifyResponse {
  /** `true` when the code matches and has not expired or been consumed. */
  valid: boolean;
}

// ── Sub-client interface ──────────────────────────────────────────────────────

/**
 * Sub-client for SMS OTP step-up authentication.
 * Accessed as `client.smsOtp` on {@link AtlaSentClient}.
 */
export interface SmsOtpSubClient {
  /**
   * Send an OTP to the given phone number for the specified action context.
   *
   * Requires a valid JWT session (not an API key). The OTP is short-lived
   * and single-use. Pass the returned `otp_id` to `verify()`.
   *
   * ```ts
   * const { otp_id, expires_at } = await client.smsOtp.send({
   *   phone_e164: "+15551234567",
   *   action_context: "break_glass",
   * });
   * ```
   */
  send(params: SmsOtpSendRequest): Promise<SmsOtpSendResponse>;

  /**
   * Verify a code against a pending OTP challenge.
   *
   * Returns `{ valid: true }` when the code matches and the OTP has not
   * expired. Returns `{ valid: false }` on mismatch or expiry — never
   * throws on a failed verification. Network or auth errors throw
   * {@link AtlaSentError}.
   *
   * ```ts
   * const { valid } = await client.smsOtp.verify({ otp_id, code });
   * if (!valid) throw new Error("OTP verification failed");
   * ```
   */
  verify(params: SmsOtpVerifyRequest): Promise<SmsOtpVerifyResponse>;
}

// ── Wire types ────────────────────────────────────────────────────────────────

interface SmsOtpSendResponseWire {
  otp_id: string;
  expires_at: string;
}

interface SmsOtpVerifyResponseWire {
  valid: boolean;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Factory that returns the SMS OTP sub-client bound to a host client's
 * transport helpers. Called internally by AtlaSentClient; not part of the
 * public constructor API.
 */
export function makeSmsOtpClient(
  postFn: <T>(path: string, body: unknown) => Promise<{ body: T }>,
): SmsOtpSubClient {
  return {
    async send(params: SmsOtpSendRequest): Promise<SmsOtpSendResponse> {
      const { body } = await postFn<SmsOtpSendResponseWire>(
        "/v1-sms-otp/send",
        {
          phone_e164: params.phone_e164,
          action_context: params.action_context,
        },
      );
      return {
        otp_id: body.otp_id,
        expires_at: body.expires_at,
      };
    },

    async verify(params: SmsOtpVerifyRequest): Promise<SmsOtpVerifyResponse> {
      const { body } = await postFn<SmsOtpVerifyResponseWire>(
        "/v1-sms-otp/verify",
        {
          otp_id: params.otp_id,
          code: params.code,
        },
      );
      return {
        valid: body.valid,
      };
    },
  };
}
