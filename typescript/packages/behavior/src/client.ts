import type { BehaviorClientOptions } from './types';

export function createBehaviorClient(opts: BehaviorClientOptions) {
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const headers = {
    'Authorization': `Bearer ${opts.apiKey}`,
    'Content-Type': 'application/json',
  };
  const timeoutMs = opts.timeoutMs ?? 10_000;

  async function get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${baseUrl}${path}`, { headers, signal: controller.signal });
      if (!res.ok) {
        throw new Error(`behavior-insights ${res.status}: ${await res.text()}`);
      }
      return res.json() as Promise<T>;
    } finally {
      clearTimeout(timer);
    }
  }

  return { get };
}
