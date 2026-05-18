import type { BehaviorClientOptions } from './types';
import { getStateSummary } from './getStateSummary';

// Enriches an evaluate request with behavior context.
// Returns a metadata object to merge into the evaluate request's metadata field.
export async function attachToEvaluate(
  userId: string,
  clientOpts: BehaviorClientOptions,
): Promise<Record<string, unknown>> {
  const summary = await getStateSummary(userId, clientOpts).catch(() => null);
  if (!summary) return {};
  return {
    behavior_context: {
      event_count: summary.event_count,
      confidence_low: Object.values(summary.category_counts).length === 0,
      window_start: summary.window_start,
      window_end: summary.window_end,
    },
  };
}
