/**
 * AtlaSent send-time authorization gate for the Gmail API.
 *
 * Implements the founder-decided interception mechanism (2026-08-09) for
 * CANON-000047 / ACT-0050 (communication.external.send — atlasent core
 * repo `contract/canonical-actions/ACT-0050-communication-external-send.yaml`):
 * a SEND-TIME API GATE. AtlaSent evaluates and verifies the send BEFORE
 * the caller's own Gmail API call is ever made — a denied or unverified
 * request never reaches Gmail. See
 * `atlasent/contract/safeguard-pack/connector-readiness/gmail.readiness.yaml`
 * for this connector's current evidence-level state (this package is real
 * G3 code, but has never been exercised against a live Gmail/Workspace
 * account or a real Google Cloud OAuth client — see this repo's README
 * for what remains an open operator prerequisite).
 *
 * Interception pattern (mirrors `@atlasent/cursor`'s `withCursorGuard` and
 * the LangChain/LlamaIndex guards in `atlasent-llm-integrations`, adapted
 * to Gmail's typed API surface rather than a generic tool-call shape):
 *
 *   1. evaluate     — check the policy engine (communication.external.send)
 *   2. verifyPermit — confirm the permit cryptographically
 *   3. send         — call the real Gmail API ONLY if both pass
 *
 * Fail-closed throughout: an evaluate/verify network error, a deny/hold/
 * escalate decision, or a failed permit verification all block the real
 * Gmail API call — there is no fallback path that sends the email anyway.
 * `runGuardedSend` below is the ONLY place in this package that invokes
 * the caller-supplied `performSend` callback, and it does so strictly
 * after both checks pass.
 *
 * Exact recipient/content binding: the caller-supplied
 * {@link GmailExternalSendFacts} (recipient + attachment content hash +
 * sensitivity flag) are folded into a SHA-256 target-id hash that is
 * presented at BOTH evaluate and verify time as `context.target.id`.
 * Mutating any of those facts between evaluate and verify (e.g. swapping
 * the recipient after a human approved a lower-risk send) changes the
 * hash, and the runtime's generic exact-binding mechanism — proven for
 * access.grant/access.revoke and communication.external.send in
 * atlasent-api's `v1-verify-permit/handler.test.ts` "exact binding" suite —
 * refuses the verify with `PERMIT_BINDING_MISMATCH`. This package invents
 * no new binding primitive; it is a thin client of the one the runtime
 * already proves.
 *
 * This wrapper deliberately does NOT parse a raw Gmail MIME payload to
 * derive the recipient/attachment facts. The connector-readiness manifest
 * makes no default choice about that (`customization_assumptions`), and
 * guessing at MIME parsing here would be exactly the kind of assumption
 * that manifest says not to invent. The caller supplies the facts
 * explicitly, sourced however fits their integration.
 */

import type { gmail_v1 } from "googleapis";
import type { AtlaSentClient, EvaluateResponse, VerifyPermitResponse } from "@atlasent/sdk";

/** ACT-0050 / CANON-000047 canonical action_type — see the atlasent core repo's
 * `contract/canonical-actions/ACT-0050-communication-external-send.yaml`. */
export const COMMUNICATION_EXTERNAL_SEND = "communication.external.send" as const;

/**
 * The exact-binding facts for one outbound external send. Folded into a
 * SHA-256 target-id hash presented to both evaluate and verify — see
 * {@link computeExternalSendTargetId}.
 */
export interface GmailExternalSendFacts {
  /** Exact recipient address (or a stable joined form for multiple recipients — e.g. sorted, comma-joined). */
  recipient: string;
  /** Whether the recipient is a previously-known/verified correspondent. */
  recipientKnown: boolean;
  /** Whether this send carries a flagged-sensitive attachment or body. */
  sensitiveAttachment: boolean;
  /**
   * SHA-256 hex content hash of the attachment/body when
   * `sensitiveAttachment` is true. Omit (or pass `""`) when there is no
   * sensitive content to hash — the omission itself is folded into the
   * binding hash, so a later addition of a sensitive attachment to an
   * otherwise-approved send still changes the hash and fails re-verify.
   */
  attachmentSha256?: string;
  /**
   * Recipient domain — the `recipient_domain` required_context_inputs
   * presence gate on the runtime's `communication.external.send` action
   * class. Derived from `recipient` (text after the last `@`) when
   * omitted and `recipient` contains an `@`.
   */
  recipientDomain?: string;
  /** Count of verified human approvals already recorded for this exact send (the bundle's `context.approvals` gate). */
  approvals: number;
  /**
   * Whether this send was initiated by a human or an AI agent. Policy
   * context / audit evidence only — no rule template or handler branch
   * in the runtime reads this value to select a different code path
   * (human/AI equivalence is a deliberate property of ACT-0050).
   */
  actorOrigin?: "human" | "ai_agent";
}

export interface GmailSendGuardOptions {
  /** AtlaSent actor identifier for the caller (e.g. `"user:sales-rep-01"`, `"agent:outreach-assistant"`). */
  agent: string;
  /** Deployment environment forwarded to evaluate/verify. Defaults to `"production"`. */
  environment?: string;
  /** Extra context merged into the evaluate call (e.g. resource ids, tenant metadata). Does not override the facts-derived fields. */
  extraContext?: Record<string, unknown>;
  /**
   * - `"result"` (default) — return a {@link GmailSendDenial} discriminated-union member on any block.
   * - `"throw"` — throw a {@link GmailSendDeniedError} on any block instead.
   */
  onDeny?: "result" | "throw";
}

export interface GmailSendDenial {
  sent: false;
  /** `"deny"` | `"hold"` | `"escalate"` | `"verify_failed"` | `"error"`. */
  decision: string;
  reason: string;
  /** Stable machine deny code (e.g. `"INSUFFICIENT_APPROVALS"`, `"NO_TEMPLATE_MATCH"`) when the block came from an evaluate-time deny. `undefined` on verify failures and transport errors. */
  denyCode?: string;
  evaluationId?: string;
  auditHash?: string;
}

export interface GmailSendSuccess<TResponse> {
  sent: true;
  /** The real Gmail API response — only ever populated once the send actually happened. */
  message: TResponse;
  permitId: string;
  auditHash: string;
}

export type GmailSendResult<TResponse> = GmailSendSuccess<TResponse> | GmailSendDenial;

/** Thrown by the guard when `onDeny: "throw"` and the send is blocked. */
export class GmailSendDeniedError extends Error {
  override name = "GmailSendDeniedError";
  readonly denial: GmailSendDenial;
  constructor(denial: GmailSendDenial) {
    super(`Gmail send blocked: ${denial.decision} — ${denial.reason}`);
    this.denial = denial;
  }
}

function targetIdInput(facts: GmailExternalSendFacts): Record<string, unknown> {
  return {
    recipient: facts.recipient,
    attachment_sha256: facts.attachmentSha256 ?? "",
    sensitive_attachment: facts.sensitiveAttachment,
  };
}

/**
 * SHA-256 hex digest over the exact recipient/attachment/sensitivity
 * facts — the `context.target.id` exact-binding value presented at both
 * evaluate and verify time. Exported so callers can compute/log it
 * independently without re-deriving the input shape (e.g. to correlate
 * with the runtime's audit chain).
 */
export async function computeExternalSendTargetId(facts: GmailExternalSendFacts): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(targetIdInput(facts)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function deriveRecipientDomain(facts: GmailExternalSendFacts): string | undefined {
  if (facts.recipientDomain) return facts.recipientDomain;
  const at = facts.recipient.lastIndexOf("@");
  return at === -1 ? undefined : facts.recipient.slice(at + 1);
}

function blocked(options: GmailSendGuardOptions, d: GmailSendDenial): GmailSendDenial {
  if ((options.onDeny ?? "result") === "throw") {
    throw new GmailSendDeniedError(d);
  }
  return d;
}

/**
 * Authorize-then-send: evaluate + verify `communication.external.send`
 * BEFORE calling `gmail.users.messages.send`. Fail-closed — the real
 * Gmail API call happens ONLY when the permit was verified.
 *
 * @example
 * ```ts
 * import { google } from "googleapis";
 * import { AtlaSentClient } from "@atlasent/sdk";
 * import { guardedGmailSend } from "@atlasent/gmail";
 *
 * const gmail = google.gmail({ version: "v1", auth: oauth2Client });
 * const atlasent = new AtlaSentClient({ apiKey, baseUrl });
 *
 * const result = await guardedGmailSend(
 *   gmail,
 *   atlasent,
 *   { userId: "me", requestBody: { raw: encodedMessage } },
 *   {
 *     recipient: "newcustomer@example.com",
 *     recipientKnown: false,
 *     sensitiveAttachment: true,
 *     attachmentSha256: "3b1c...deadbeef",
 *     approvals: 1,
 *   },
 *   { agent: "user:sales-rep-01" },
 * );
 * if (!result.sent) {
 *   // result.decision / result.reason explain why nothing was sent.
 * }
 * ```
 */
export async function guardedGmailSend(
  gmail: Pick<gmail_v1.Gmail, "users">,
  atlasent: AtlaSentClient,
  request: gmail_v1.Params$Resource$Users$Messages$Send,
  facts: GmailExternalSendFacts,
  options: GmailSendGuardOptions,
): Promise<GmailSendResult<gmail_v1.Schema$Message>> {
  return runGuardedSend(atlasent, facts, options, async () => (await gmail.users.messages.send(request)).data);
}

/**
 * Authorize-then-send an already-composed draft via
 * `gmail.users.drafts.send`. Same gate as {@link guardedGmailSend}.
 *
 * `gmail.users.drafts.create` is deliberately NOT wrapped by this
 * package — creating a draft does not deliver mail (no external send
 * occurs), so it is out of scope for the ACT-0050 gate. Only
 * `drafts.send` and `messages.send` are real
 * `communication.external.send` events.
 */
export async function guardedGmailSendDraft(
  gmail: Pick<gmail_v1.Gmail, "users">,
  atlasent: AtlaSentClient,
  request: gmail_v1.Params$Resource$Users$Drafts$Send,
  facts: GmailExternalSendFacts,
  options: GmailSendGuardOptions,
): Promise<GmailSendResult<gmail_v1.Schema$Message>> {
  return runGuardedSend(atlasent, facts, options, async () => (await gmail.users.drafts.send(request)).data);
}

async function runGuardedSend<TResponse>(
  atlasent: AtlaSentClient,
  facts: GmailExternalSendFacts,
  options: GmailSendGuardOptions,
  performSend: () => Promise<TResponse>,
): Promise<GmailSendResult<TResponse>> {
  const environment = options.environment ?? "production";
  const targetId = await computeExternalSendTargetId(facts);

  const context: Record<string, unknown> = {
    ...options.extraContext,
    recipient_known: facts.recipientKnown,
    sensitive_attachment: facts.sensitiveAttachment,
    approvals: facts.approvals,
    target: { id: targetId },
  };
  const recipientDomain = deriveRecipientDomain(facts);
  if (recipientDomain !== undefined) context["recipient_domain"] = recipientDomain;
  if (facts.actorOrigin !== undefined) context["actor_origin"] = facts.actorOrigin;

  let evalResp: EvaluateResponse;
  try {
    evalResp = await atlasent.evaluate({
      actor_id: options.agent,
      action_type: COMMUNICATION_EXTERNAL_SEND,
      environment,
      context,
    });
  } catch (err) {
    return blocked(options, {
      sent: false,
      decision: "error",
      reason: `evaluate failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  if (evalResp.decision !== "allow") {
    return blocked(options, {
      sent: false,
      decision: evalResp.decision,
      reason: evalResp.reason || `blocked by decision=${evalResp.decision}`,
      ...(evalResp.deny_code !== null ? { denyCode: evalResp.deny_code } : {}),
      evaluationId: evalResp.evaluationId,
      auditHash: evalResp.auditHash,
    });
  }

  const permitId = evalResp.permitId;

  let verifyResp: VerifyPermitResponse;
  try {
    verifyResp = await atlasent.verifyPermit({
      permitId,
      agent: options.agent,
      action: COMMUNICATION_EXTERNAL_SEND,
      environment,
      context: { target: { id: targetId } },
    });
  } catch (err) {
    return blocked(options, {
      sent: false,
      decision: "error",
      reason: `verifyPermit failed: ${err instanceof Error ? err.message : String(err)}`,
      evaluationId: evalResp.evaluationId,
      auditHash: evalResp.auditHash,
    });
  }

  if (!verifyResp.verified) {
    return blocked(options, {
      sent: false,
      decision: "verify_failed",
      reason: `permit verification failed: outcome=${verifyResp.outcome}`,
      evaluationId: evalResp.evaluationId,
      auditHash: evalResp.auditHash,
    });
  }

  // ONLY reachable once evaluate returned allow AND verify confirmed the
  // permit. This is the single call site in this file that ever invokes
  // the caller-supplied Gmail API call.
  const message = await performSend();

  return {
    sent: true,
    message,
    permitId,
    auditHash: evalResp.auditHash,
  };
}
