import { createBehaviorClient } from './client';
import type { BehaviorCategory, BehaviorClientOptions, GetCategoryAggregateOptions, CategoryAggregate } from './types';

export async function getCategoryAggregate(
  userId: string,
  category: BehaviorCategory,
  clientOpts: BehaviorClientOptions,
  opts?: GetCategoryAggregateOptions,
): Promise<CategoryAggregate> {
  const client = createBehaviorClient(clientOpts);
  const qs = opts?.windowDays ? `?window_days=${opts.windowDays}` : '';
  return client.get<CategoryAggregate>(
    `/api/patterns/category/${encodeURIComponent(userId)}/${encodeURIComponent(category)}${qs}`
  );
}
