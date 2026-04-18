/**
 * AtlaSentMock — drop-in test double for {@link AtlaSentClient}.
 *
 * ```typescript
 * import { AtlaSentMock } from '@atlasent/sdk/testing';
 *
 * const mock = new AtlaSentMock();
 * mock.allowAll();
 * // or
 * mock.denyAll();
 * // or
 * mock.setDecision('deployment.production', 'deny');
 *
 * const result = await mock.evaluate({ action: { id: 'deployment.production' }, actor });
 * // result.outcome === 'deny'
 * ```
 */

import type { EvaluationPayload, EvaluationResult } from '@atlasent/types';

type Outcome = 'allow' | 'deny';

export class AtlaSentMock {
  private defaultOutcome: Outcome = 'allow';
  private decisions = new Map<string, Outcome>();

  /** All evaluations return `allow` (default). */
  allowAll(): void {
    this.defaultOutcome = 'allow';
    this.decisions.clear();
  }

  /** All evaluations return `deny`. */
  denyAll(): void {
    this.defaultOutcome = 'deny';
    this.decisions.clear();
  }

  /** Override the outcome for a specific action ID. */
  setDecision(actionId: string, outcome: Outcome): void {
    this.decisions.set(actionId, outcome);
  }

  /** Evaluate a payload — returns a synthetic {@link EvaluationResult}. */
  async evaluate(payload: EvaluationPayload): Promise<EvaluationResult> {
    const actionId = payload.action?.id ?? '';
    const outcome = this.decisions.get(actionId) ?? this.defaultOutcome;
    return {
      outcome,
      permit_id: `mock-permit-${Date.now()}`,
      risk: {
        level: outcome === 'deny' ? 'high' : 'low',
        score: outcome === 'deny' ? 1.0 : 0.0,
        reasons: outcome === 'deny' ? [`Action '${actionId}' is mocked as denied`] : [],
      },
      audit_hash: 'mock-audit-hash',
      timestamp: new Date().toISOString(),
    } as unknown as EvaluationResult;
  }

  /** Verify a permit — always returns `{ verified: true }` in mock mode. */
  async verifyPermit(_id: string): Promise<{ verified: boolean }> {
    return { verified: true };
  }

  /** Consume a permit — no-op in mock mode. */
  async consumePermit(_id: string): Promise<void> {
    return;
  }

  /** Get session — returns a minimal mock session. */
  async getSession(): Promise<{ mock: true }> {
    return { mock: true };
  }
}
