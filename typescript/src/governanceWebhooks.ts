/**
 * Governance and enforcement webhook types — wire shapes for
 * `v1-governance-webhooks` and `v1-enforcement-webhooks`.
 *
 * Covers subscription management, signed delivery callbacks, and
 * delivery receipt records. Use `verifyWebhookSignature` in your
 * receiver to authenticate payloads.
 */

export type GovernanceWebhookEvent =
  | "enforcement.blocked"
  | "policy.violation"
  | "access_review.completed"
  | "mfa.enrollment_required"
  | "contract.activated"
  | "replay.drift_detected";

export type EnforcementWebhookEvent =
  | "enforcement.blocked"
  | "enforcement.pending_approval"
  | "enforcement.approved"
  | "enforcement.expired";

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface WebhookSubscription {
  id: string;
  org_id: string;
  url: string;
  events: string[];
  enabled: boolean;
  description: string | null;
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  subscription_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  status: WebhookDeliveryStatus;
  response_status: number | null;
  response_body: string | null;
  attempted_at: string;
}

export interface CreateWebhookSubscriptionRequest {
  url: string;
  events: string[];
  enabled?: boolean;
  description?: string;
}

export interface ListWebhookSubscriptionsResponse {
  subscriptions: WebhookSubscription[];
  /** For governance webhooks, the server returns supported event names. */
  valid_events?: string[];
}

export interface ListWebhookDeliveriesResponse {
  deliveries: WebhookDelivery[];
}

/**
 * Signed webhook payload delivered to subscriber endpoints.
 *
 * AtlaSent sets two headers on every delivery:
 * - `X-AtlaSent-Signature: sha256=<hex>` — HMAC-SHA256 of the raw body
 * - `X-AtlaSent-Event: <event_type>`
 *
 * Verify with `verifyWebhookSignature` before processing.
 */
export interface WebhookPayload<T = Record<string, unknown>> {
  id: string;
  org_id: string;
  event_type: string;
  source_id: string | null;
  data: T;
  created_at: string;
}

/**
 * Verify a webhook delivery signature using the subscription secret.
 *
 * Performs a constant-time HMAC-SHA256 comparison so timing attacks
 * cannot reveal secret length. Requires `globalThis.crypto.subtle`
 * (Node 20+, all modern browsers, Deno, Cloudflare Workers).
 *
 * @param payload   Raw UTF-8 request body string.
 * @param signature Value of the `X-AtlaSent-Signature` header.
 * @param secret    Webhook subscription secret from the AtlaSent console.
 * @returns `true` when the signature is valid.
 *
 * @example
 * ```ts
 * import { verifyWebhookSignature } from "@atlasent/sdk";
 *
 * app.post("/webhook", async (req, res) => {
 *   const ok = await verifyWebhookSignature(
 *     req.rawBody,
 *     req.headers["x-atlasent-signature"],
 *     process.env.WEBHOOK_SECRET!,
 *   );
 *   if (!ok) return res.status(401).send("invalid signature");
 *   // process req.body …
 * });
 * ```
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) return false;
  const receivedHex = signature.slice(prefix.length);

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  const expectedHex = Array.from(new Uint8Array(sigBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (receivedHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedHex.length; i++) {
    diff |= receivedHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}
