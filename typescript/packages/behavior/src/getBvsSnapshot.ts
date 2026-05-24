import type { BehaviorClientOptions, BvsSnapshot } from './types';
import { createBehaviorClient } from './client';

export async function getBvsSnapshot(
  userId: string,
  clientOpts: BehaviorClientOptions,
): Promise<BvsSnapshot | null> {
  const client = createBehaviorClient(clientOpts);
  return client.get<BvsSnapshot | null>(`/api/patterns/snapshot/${encodeURIComponent(userId)}`);
}
