/**
 * AsyncClient — v1.1 parallel evaluation helper.
 *
 * Wraps {@link AtlaSentClient} and adds:
 *   - `evaluate()` — single evaluation (delegates to AtlaSentClient)
 *   - `authorizeMany()` — parallel batch evaluation via Promise.all
 */

import { AtlaSentClient, type AtlaSentClientOptions } from './client.js';
import type { EvaluationPayload, EvaluationResult } from '@atlasent/types';

export type { AtlaSentClientOptions };

export class AsyncClient {
  private readonly client: AtlaSentClient;

  constructor(options: AtlaSentClientOptions) {
    this.client = new AtlaSentClient(options);
  }

  /**
   * Evaluate a single action. Delegates to {@link AtlaSentClient.evaluate}.
   */
  evaluate(payload: EvaluationPayload): Promise<EvaluationResult> {
    return this.client.evaluate(payload);
  }

  /**
   * Evaluate multiple actions concurrently.
   *
   * Results are returned in the same order as the input array.
   * Each item either resolves to an {@link EvaluationResult} or rejects
   * independently — use `Promise.allSettled` at the call site if you
   * need partial-failure semantics.
   *
   * ```typescript
   * const results = await client.authorizeMany([
   *   { action: { id: 'deployment.production' }, actor },
   *   { action: { id: 'data.export' }, actor },
   * ]);
   * ```
   */
  authorizeMany(payloads: EvaluationPayload[]): Promise<EvaluationResult[]> {
    return Promise.all(payloads.map((p) => this.client.evaluate(p)));
  }
}
