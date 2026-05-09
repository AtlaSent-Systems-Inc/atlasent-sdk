/**
 * Delegation revocation propagation — wire shape for the
 * `propagate_delegation_revocation()` summary returned by
 * `/v1/authority-delegations/:id/revoke` (and emitted as the
 * `authority_delegation.propagated` audit event).
 *
 * Mirrors migration 20260509120001. The propagator is invoked
 * automatically on `status -> revoked` via DB trigger; consumers
 * see the summary either as the audit-event payload (asynchronous)
 * or attached to the revoke response (synchronous).
 */

export interface DelegationPropagationSummary {
  delegation_id: string;
  /** `[delegator_user_id, delegate_user_id]` — uuids as strings. */
  principals: [string, string];
  /** Phase-B role-justified delegations carry the role; user-justified
   *  delegations omit it. */
  delegator_role?: string | null;
  hitl_reassigned: number;
  financial_invalidated: number;
  policies_flagged: number;
  revoked_reason?: string | null;
}

/**
 * Convenience predicate: `true` when the revocation produced any
 * downstream effect. Useful for "are we sure?" UI guards before
 * surfacing the summary toast.
 */
export function delegationPropagationHadEffect(
  s: DelegationPropagationSummary,
): boolean {
  return (
    s.hitl_reassigned > 0 ||
    s.financial_invalidated > 0 ||
    s.policies_flagged > 0
  );
}
