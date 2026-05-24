import type { BehaviorClientOptions } from './types';
import { getBvsSnapshot } from './getBvsSnapshot';

// Enriches an evaluate request context with the frozen BvsSnapshot wire shape (BI4).
// Returns an object to spread into EvaluateRequest.context.
// Returns {} when the snapshot is unavailable (service down, no data) — fail-open.
export async function attachToEvaluate(
  userId: string,
  clientOpts: BehaviorClientOptions,
): Promise<Record<string, unknown>> {
  const snapshot = await getBvsSnapshot(userId, clientOpts).catch(() => null);
  if (!snapshot) return {};
  return { bvsSnapshot: snapshot };
}
