import type { EvaluationPayload, EvaluationResult, Decision, RiskLevel } from '@atlasent/types';
import { AtlaSentClient, type AtlaSentClientOptions } from '../client.ts';

type MockRule = { actorId?: string; actionType?: string; decision: Decision; riskLevel?: RiskLevel };

export class AtlaSentMock extends AtlaSentClient {
  private rules: MockRule[] = [];
  private defaultDecision: Decision = 'allow';
  private calls: EvaluationPayload[] = [];

  constructor() {
    super({ apiUrl: 'http://mock', apiKey: 'mock' });
  }

  allowAll() { this.defaultDecision = 'allow'; return this; }
  denyAll() { this.defaultDecision = 'deny'; return this; }
  requireApprovalAll() { this.defaultDecision = 'require_approval'; return this; }

  setDecision(rule: MockRule) { this.rules.unshift(rule); return this; }
  getCalls() { return this.calls; }
  reset() { this.rules = []; this.calls = []; this.defaultDecision = 'allow'; return this; }

  override async evaluate(payload: EvaluationPayload): Promise<EvaluationResult> {
    this.calls.push(payload);
    const rule = this.rules.find(r =>
      (!r.actorId || r.actorId === payload.actor.id) &&
      (!r.actionType || r.actionType === payload.action.type)
    );
    const decision = rule?.decision ?? this.defaultDecision;
    const level = rule?.riskLevel ?? (decision === 'deny' ? 'high' : 'low');
    const scoreMap: Record<RiskLevel, number> = { low: 15, medium: 45, high: 75, critical: 95 };
    return {
      id: crypto.randomUUID(),
      decision,
      risk: { score: scoreMap[level], level, factors: [] },
      evaluatedAt: new Date().toISOString(),
      ...(decision === 'allow' ? { permitId: crypto.randomUUID() } : {}),
    };
  }
}
