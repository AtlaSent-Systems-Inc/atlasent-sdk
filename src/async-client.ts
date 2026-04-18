/**
 * AsyncClient — v1.1 addition.
 * Extends AtlaSentClient with concurrent evaluation and batch authorize_many.
 */

import { AtlaSentClient, type AtlaSentClientOptions } from './client';
import type { EvaluationPayload, EvaluationResult } from '@atlasent/types';

export class AsyncClient extends AtlaSentClient {
  constructor(options: AtlaSentClientOptions) {
    super(options);
  }

  /**
   * Evaluate multiple actions concurrently.
   * Results are returned in the same order as the input array.
   * Partial failures surface per-item (rejected promise items contain the error).
   */
  async authorizeMany(
    requests: EvaluationPayload[]
  ): Promise<PromiseSettledResult<EvaluationResult>[]> {
    return Promise.allSettled(requests.map((req) => this.evaluate(req)));
  }
}
