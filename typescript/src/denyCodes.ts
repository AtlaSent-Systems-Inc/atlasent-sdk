/**
 * Stable deny-code constants and helpers.
 *
 * The AtlaSent API returns a `deny_code` — a stable, UPPER_SNAKE machine
 * string naming *why* a non-allow decision was reached (e.g.
 * `"SNAPSHOT_REQUIRED"`). The wire field is an open string (new codes can
 * appear without an SDK release), so this is a *convenience* registry of the
 * codes documented today plus a predicate for the human-approval gate. Treat
 * unknown codes as a generic deny — never assume this list is exhaustive.
 *
 * Branch on `deny_code`, never on the human-readable reason.
 */

/** Known `deny_code` values. Not exhaustive — the wire field is open. */
export const DENY_CODES = {
  UNKNOWN_PROTECTED_ACTION: "UNKNOWN_PROTECTED_ACTION",
  ENVIRONMENT_MISMATCH: "ENVIRONMENT_MISMATCH",
  NO_AUTHORITY: "NO_AUTHORITY",
  NO_SNAPSHOT: "NO_SNAPSHOT",
  SNAPSHOT_TAMPERED: "SNAPSHOT_TAMPERED",
  SNAPSHOT_REQUIRED: "SNAPSHOT_REQUIRED",
  DEPENDENCY_NOT_SATISFIED: "DEPENDENCY_NOT_SATISFIED",
  SIGNAL_UNTRUSTED: "SIGNAL_UNTRUSTED",
  LATENCY_BUDGET_EXCEEDED: "LATENCY_BUDGET_EXCEEDED",
  HARD_CONSTRAINT_VIOLATED: "HARD_CONSTRAINT_VIOLATED",
  INTENT_MISMATCH: "INTENT_MISMATCH",
  PRESSURE_THRESHOLD_EXCEEDED: "PRESSURE_THRESHOLD_EXCEEDED",
  BOUNDARY_VIOLATION: "BOUNDARY_VIOLATION",
  PERMIT_UNBOUND_EXECUTION: "PERMIT_UNBOUND_EXECUTION",
  EXECUTION_PAYLOAD_HASH_REQUIRED: "EXECUTION_PAYLOAD_HASH_REQUIRED",
  /**
   * Fewer verified human approvals than policy requires — emitted (among other
   * cases) by the per-class human-in-the-loop gate (`requires_human_approval`
   * reached without a verified approval). A human must approve; route to an
   * approval queue and re-evaluate. `retry_advice` is `after_human_approval`.
   */
  INSUFFICIENT_APPROVALS: "INSUFFICIENT_APPROVALS",
} as const;

/** A documented deny code. The wire `deny_code` may also be any other string. */
export type DenyCode = (typeof DENY_CODES)[keyof typeof DENY_CODES];

/**
 * True when the denial indicates a human approval is required.
 *
 * Accepts a raw `deny_code` string, or any object carrying one (an
 * {@link AtlaSentDeniedError} or an evaluate response). Lets callers route a
 * denied action into an approval queue instead of treating it as a hard
 * refusal:
 *
 * ```ts
 * try {
 *   await atlasent.protect({ agent, action: "agent.bulk_delete", context });
 * } catch (err) {
 *   if (isHumanApprovalRequired(err)) queueForHumanReview(...);
 *   else throw err;
 * }
 * ```
 */
export function isHumanApprovalRequired(
  input: string | null | undefined | { deny_code?: string | null },
): boolean {
  const code = typeof input === "string" || input == null ? input : input.deny_code;
  return code === DENY_CODES.INSUFFICIENT_APPROVALS;
}
