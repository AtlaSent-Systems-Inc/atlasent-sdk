import { AtlaSentClient, type AtlaSentClientOptions } from './client.ts';
import type { EvaluationPayload, EvaluationResult } from '@atlasent/types';

export type AuthorizeManyResult = {
  payload: EvaluationPayload;
  result: EvaluationResult | null;
  error: Error | null;
};

export class AsyncClient extends AtlaSentClient {
  constructor(options: AtlaSentClientOptions) {
    super(options);
  }

  async authorizeMany(payloads: EvaluationPayload[]): Promise<AuthorizeManyResult[]> {
    const settled = await Promise.allSettled(payloads.map(p => this.evaluate(p)));
    return payloads.map((payload, i) => {
      const s = settled[i]!;
      return {
        payload,
        result: s.status === 'fulfilled' ? s.value : null,
        error: s.status === 'rejected' ? (s.reason as Error) : null,
      };
    });
  }

  async authorizeAll(payloads: EvaluationPayload[]): Promise<EvaluationResult[]> {
    return Promise.all(payloads.map(p => this.evaluate(p)));
  }
}
