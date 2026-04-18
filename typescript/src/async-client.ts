import { AtlaSentClient } from './client.ts';
import type { AtlaSentClientOptions, EvaluateRequest, EvaluateResponse } from './types.ts';

export type AuthorizeManyResult = {
  request: EvaluateRequest;
  result: EvaluateResponse | null;
  error: Error | null;
};

export class AsyncClient extends AtlaSentClient {
  constructor(options: AtlaSentClientOptions) {
    super(options);
  }

  async authorizeMany(requests: EvaluateRequest[]): Promise<AuthorizeManyResult[]> {
    const settled = await Promise.allSettled(requests.map(r => this.evaluate(r)));
    return requests.map((request, i) => {
      const s = settled[i]!;
      return {
        request,
        result: s.status === 'fulfilled' ? s.value : null,
        error: s.status === 'rejected' ? (s.reason as Error) : null,
      };
    });
  }

  async authorizeAll(requests: EvaluateRequest[]): Promise<EvaluateResponse[]> {
    return Promise.all(requests.map(r => this.evaluate(r)));
  }
}
