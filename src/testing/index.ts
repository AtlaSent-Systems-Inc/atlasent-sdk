/**
 * AtlaSentMock — v1.1 testing module.
 * Drop-in replacement for AtlaSentClient in unit tests.
 */

import type { EvaluationPayload, EvaluationResult, Decision, DecisionOutcome } from '@atlasent/types';

type MockDecision = DecisionOutcome | ((payload: EvaluationPayload) => DecisionOutcome);

export class AtlaSentMock {
  private rules = new Map<string, MockDecision>();
  private defaultOutcome: DecisionOutcome = 'allow';

  allowAll(): this {
    this.defaultOutcome = 'allow';
    return this;
  }

  denyAll(): this {
    this.defaultOutcome = 'deny';
    return this;
  }

  setDecision(actionId: string, decision: MockDecision): this {
    this.rules.set(actionId, decision);
    return this;
  }

  async evaluate(payload: EvaluationPayload): Promise<EvaluationResult> {
    const rule = this.rules.get(payload.action.id);
    const outcome: DecisionOutcome =
      typeof rule === 'function'
        ? rule(payload)
        : rule ?? this.defaultOutcome;

    const decision: Decision = {
      outcome,
      risk: { level: 'low', score: 0, reasons: [] },
      evaluated_at: new Date().toISOString(),
      evaluation_id: `mock_eval_${Math.random().toString(36).slice(2)}`,
    };

    return {
      decision,
      policy_id: 'mock_policy',
      policy_version: 1,
    };
  }

  async authorizeMany(requests: EvaluationPayload[]) {
    return Promise.allSettled(requests.map((r) => this.evaluate(r)));
  }
}
