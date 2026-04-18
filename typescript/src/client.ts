import type { EvaluationPayload, EvaluationResult, Permit, Session } from '@atlasent/types';

export interface AtlaSentClientOptions {
  apiUrl: string;
  apiKey: string;
  timeout?: number;
}

export interface EvaluateOptions {
  payload: EvaluationPayload;
}

export type AuthorizeResult = EvaluationResult & { permitted: boolean };

export class AtlaSentClient {
  protected readonly apiUrl: string;
  protected readonly apiKey: string;
  protected readonly timeout: number;

  constructor(options: AtlaSentClientOptions) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '');
    this.apiKey = options.apiKey;
    this.timeout = options.timeout ?? 10_000;
  }

  protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(`${this.apiUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-AtlaSent-Key': this.apiKey,
          ...init.headers,
        },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw Object.assign(new Error(err.message ?? 'Request failed'), { status: res.status, code: err.code });
      }
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async evaluate(payload: EvaluationPayload): Promise<EvaluationResult> {
    return this.request<EvaluationResult>('/v1/evaluate', { method: 'POST', body: JSON.stringify(payload) });
  }

  async authorize(payload: EvaluationPayload): Promise<AuthorizeResult> {
    const result = await this.evaluate(payload);
    return { ...result, permitted: result.decision === 'allow' };
  }

  async verifyPermit(permitId: string): Promise<Permit> {
    return this.request<Permit>(`/v1/permits/${permitId}/verify`, { method: 'POST' });
  }

  async consumePermit(permitId: string): Promise<Permit> {
    return this.request<Permit>(`/v1/permits/${permitId}/consume`, { method: 'POST' });
  }

  async getSession(): Promise<Session> {
    return this.request<Session>('/v1/session');
  }
}
