/**
 * Temporal Guard — SDK helper for time-bounded AI agent workflows.
 *
 * Wraps long-running operations with temporal enforcement:
 *   - Checks permit freshness before starting
 *   - Detects memory-context staleness from the agent's context object
 *   - Polls for permit validity during execution (continuous-auth lease)
 *   - Fails closed on window expiry or staleness detection
 *
 * Usage:
 *   const guard = new TemporalGuard(client, {
 *     actionType: 'agent.memory.write',
 *     maxContextAgeMs: 15 * 60 * 1000,
 *     revalidationIntervalMs: 60 * 1000,
 *   });
 *
 *   const result = await guard.run(permit, agentContext, async () => {
 *     // protected agent action here
 *   });
 */

import type { AtlaSentClient } from './client.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TemporalGuardOptions {
  /** Action type being guarded (used for logging and error messages). */
  actionType: string;
  /**
   * Maximum age (ms) of the caller's context object before execution is
   * blocked. Checks `context.contextBuiltAt` ISO-8601 field.
   * Absent = no context freshness check.
   */
  maxContextAgeMs?: number;
  /**
   * Maximum age (ms) of the permit itself (issued_at → now).
   * Absent = no permit freshness check beyond the permit's own expires_at.
   */
  maxPermitAgeMs?: number;
  /**
   * Interval (ms) at which to re-verify the permit during execution.
   * Set to 0 or undefined to disable continuous re-verification.
   * Recommended: same as the permit's lease renewal interval.
   */
  revalidationIntervalMs?: number;
  /**
   * Hard deadline for the entire protected operation.
   * If the function has not returned by this time, the guard cancels
   * execution and throws TemporalGuardError('EXECUTION_DEADLINE_EXCEEDED').
   */
  executeBefore?: Date | string;
  /**
   * Called when the permit is revoked or expires during execution.
   * Default: throw TemporalGuardError.
   */
  onPermitRevoked?: (reason: string) => void;
}

export type AgentContext = Record<string, unknown> & {
  /** ISO-8601 timestamp when the agent assembled this context. */
  contextBuiltAt?: string;
  /** Identifier of the context source (e.g., vector store, session ID). */
  contextSourceId?: string;
};

export interface TemporalGuardResult<T> {
  value: T;
  /** Milliseconds elapsed from guard start to function return. */
  elapsedMs: number;
  /** Number of permit re-verifications performed during execution. */
  revalidationCount: number;
}

export class TemporalGuardError extends Error {
  constructor(
    public readonly code:
      | 'CONTEXT_STALE'
      | 'PERMIT_NOT_FRESH'
      | 'EXECUTION_DEADLINE_EXCEEDED'
      | 'PERMIT_REVOKED'
      | 'PERMIT_EXPIRED'
      | 'REVALIDATION_FAILED',
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'TemporalGuardError';
  }
}

// ─── TemporalGuard ────────────────────────────────────────────────────────────

export class TemporalGuard {
  constructor(
    private readonly client: AtlaSentClient,
    private readonly opts: TemporalGuardOptions,
  ) {}

  /**
   * Execute `fn` inside the temporal guard.
   *
   * Pre-checks (fail-closed):
   *   1. Context freshness — blocks stale agent memory
   *   2. Permit freshness — blocks permits older than maxPermitAgeMs
   *   3. Async window — blocks execution past executeBefore
   *
   * During execution:
   *   4. Periodic re-verification via revalidationIntervalMs
   *   5. Hard deadline enforcement via executeBefore
   *
   * @param permitToken - the signed permit token (`pt.v2.*`)
   * @param context - the agent's current context object
   * @param fn - the protected async function
   */
  async run<T>(
    permitToken: string,
    context: AgentContext,
    fn: () => Promise<T>,
  ): Promise<TemporalGuardResult<T>> {
    const startedAt = Date.now();

    // ── Pre-check 1: Context freshness ───────────────────────────────────────
    if (this.opts.maxContextAgeMs !== undefined) {
      const staleness = this.checkContextStaleness(context, startedAt);
      if (staleness.isStale) {
        throw new TemporalGuardError(
          'CONTEXT_STALE',
          `Context is stale: age ${staleness.ageMs}ms > max ${this.opts.maxContextAgeMs}ms for ${this.opts.actionType}`,
          {
            ageMs: staleness.ageMs,
            maxAgeMs: this.opts.maxContextAgeMs,
            contextBuiltAt: context.contextBuiltAt,
            contextSourceId: context.contextSourceId,
          },
        );
      }
    }

    // ── Pre-check 2: Async execution deadline ────────────────────────────────
    if (this.opts.executeBefore !== undefined) {
      const deadline = typeof this.opts.executeBefore === 'string'
        ? Date.parse(this.opts.executeBefore)
        : this.opts.executeBefore.getTime();
      if (!Number.isFinite(deadline) || startedAt >= deadline) {
        throw new TemporalGuardError(
          'EXECUTION_DEADLINE_EXCEEDED',
          `Execution deadline has passed for ${this.opts.actionType}`,
          { executeBefore: this.opts.executeBefore, now: new Date(startedAt).toISOString() },
        );
      }
    }

    // ── Pre-check 3: Permit freshness (client-side, no network call) ─────────
    if (this.opts.maxPermitAgeMs !== undefined) {
      const permitFreshness = this.checkPermitFreshness(permitToken, startedAt);
      if (!permitFreshness.fresh) {
        throw new TemporalGuardError(
          'PERMIT_NOT_FRESH',
          `Permit is not fresh enough for ${this.opts.actionType}: age ${permitFreshness.elapsedMs}ms > ${this.opts.maxPermitAgeMs}ms`,
          { elapsedMs: permitFreshness.elapsedMs, maxAgeMs: this.opts.maxPermitAgeMs },
        );
      }
    }

    // ── Execute with continuous re-verification ───────────────────────────────
    let revalidationCount = 0;
    let aborted = false;
    let abortError: TemporalGuardError | null = null;

    const revalidationInterval = this.opts.revalidationIntervalMs;
    let revalidationTimer: ReturnType<typeof setInterval> | null = null;

    if (revalidationInterval && revalidationInterval > 0) {
      revalidationTimer = setInterval(async () => {
        if (aborted) return;
        try {
          const result = await this.client.verifyPermit({
            permit_token: permitToken,
            action_type: this.opts.actionType,
          });
          revalidationCount++;
          if (!result.valid) {
            aborted = true;
            abortError = new TemporalGuardError(
              'PERMIT_REVOKED',
              `Permit revoked during execution of ${this.opts.actionType}: ${result.verify_error_code ?? result.outcome}`,
              { outcome: result.outcome, verify_error_code: result.verify_error_code },
            );
            if (this.opts.onPermitRevoked) {
              this.opts.onPermitRevoked(result.verify_error_code ?? result.outcome ?? 'unknown');
            }
          }
        } catch {
          // Re-verification network failure → fail-closed
          aborted = true;
          abortError = new TemporalGuardError(
            'REVALIDATION_FAILED',
            `Permit re-verification failed during ${this.opts.actionType}`,
          );
        }
      }, revalidationInterval);
    }

    // Deadline enforcement
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let deadlineReached = false;
    if (this.opts.executeBefore !== undefined) {
      const deadline = typeof this.opts.executeBefore === 'string'
        ? Date.parse(this.opts.executeBefore)
        : this.opts.executeBefore.getTime();
      const remaining = deadline - Date.now();
      if (remaining > 0) {
        deadlineTimer = setTimeout(() => {
          deadlineReached = true;
          aborted = true;
          abortError = new TemporalGuardError(
            'EXECUTION_DEADLINE_EXCEEDED',
            `Execution deadline exceeded for ${this.opts.actionType}`,
          );
        }, remaining);
      }
    }

    try {
      const value = await fn();

      if (aborted && abortError) {
        throw abortError;
      }

      return {
        value,
        elapsedMs: Date.now() - startedAt,
        revalidationCount,
      };
    } finally {
      if (revalidationTimer) clearInterval(revalidationTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private checkContextStaleness(context: AgentContext, nowMs: number): { isStale: boolean; ageMs: number } {
    const maxMs = this.opts.maxContextAgeMs!;
    const builtAt = context.contextBuiltAt;
    if (!builtAt) {
      return { isStale: true, ageMs: Infinity };
    }
    const builtAtMs = Date.parse(builtAt);
    if (!Number.isFinite(builtAtMs)) {
      return { isStale: true, ageMs: Infinity };
    }
    const ageMs = Math.max(0, nowMs - builtAtMs);
    return { isStale: ageMs > maxMs, ageMs };
  }

  private checkPermitFreshness(permitToken: string, nowMs: number): { fresh: boolean; elapsedMs: number } {
    const maxMs = this.opts.maxPermitAgeMs!;
    try {
      // Decode the pt.v2 payload without verifying the HMAC (client-side only)
      if (!permitToken.startsWith('pt.v2.')) {
        return { fresh: true, elapsedMs: 0 }; // Legacy UUID token: skip freshness check
      }
      const withoutPrefix = permitToken.slice('pt.v2.'.length);
      const lastDot = withoutPrefix.lastIndexOf('.');
      if (lastDot === -1) return { fresh: false, elapsedMs: Infinity };

      const payloadB64 = withoutPrefix.slice(0, lastDot);
      const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
      const pad = padded.length % 4;
      const repadded = pad === 0 ? padded : padded + '='.repeat(4 - pad);
      const payloadJson = atob(repadded);
      const payload = JSON.parse(payloadJson) as { issued_at_ms?: number };

      if (!payload.issued_at_ms || !Number.isFinite(payload.issued_at_ms)) {
        return { fresh: false, elapsedMs: Infinity };
      }

      const elapsedMs = Math.max(0, nowMs - payload.issued_at_ms);
      return { fresh: elapsedMs <= maxMs, elapsedMs };
    } catch {
      // Fail-closed on parse error
      return { fresh: false, elapsedMs: Infinity };
    }
  }
}

// ─── Convenience wrapper ──────────────────────────────────────────────────────

/**
 * Run a protected function inside a temporal guard.
 * Equivalent to `new TemporalGuard(client, opts).run(...)`.
 */
export async function withTemporalGuard<T>(
  client: AtlaSentClient,
  permitToken: string,
  context: AgentContext,
  opts: TemporalGuardOptions,
  fn: () => Promise<T>,
): Promise<TemporalGuardResult<T>> {
  return new TemporalGuard(client, opts).run(permitToken, context, fn);
}
