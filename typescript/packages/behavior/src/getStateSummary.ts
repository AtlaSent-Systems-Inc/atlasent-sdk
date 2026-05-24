import { createBehaviorClient } from './client';
import type { BehaviorClientOptions, GetStateSummaryOptions, StateSummary } from './types';
import { assertNoRawText } from './privacy';

export async function getStateSummary(
  userId: string,
  clientOpts: BehaviorClientOptions,
  opts?: GetStateSummaryOptions,
): Promise<StateSummary | null> {
  const client = createBehaviorClient(clientOpts);
  const qs = opts?.windowDays ? `?window_days=${opts.windowDays}` : '';
  const data = await client.get<StateSummary | null>(`/api/patterns/summary/${encodeURIComponent(userId)}${qs}`);
  if (data !== null) assertNoRawText(data, 'StateSummary');
  return data;
}
