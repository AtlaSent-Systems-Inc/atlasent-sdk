import { AtlaSentError } from './errors.ts';
import type {
  AtlaSentClientOptions,
  EvaluateRequest,
  EvaluateResponse,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from './types.ts';

// ─── Wire shapes (private) ────────────────────────────────────────────────────

interface EvaluateWire {
  permitted: boolean;
  decision_id: string;
  reason?: string;
  audit_hash: string;
  timestamp: string;
}

interface VerifyWire {
  verified: boolean;
  outcome: string;
  permit_hash: string;
  timestamp: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://api.atlasent.io';
const SDK_VERSION = '1.1.0';

function buildUserAgent(): string {
  let nodeVer = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nodeVer = (globalThis as any).process?.version ?? '';
  } catch { /* browser */ }
  return `@atlasent/sdk/${SDK_VERSION} node/${nodeVer}`;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const raw = headers.get('Retry-After');
  if (!raw) return undefined;
  const s = parseInt(raw, 10);
  return Number.isFinite(s) ? s * 1_000 : undefined;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class AtlaSentClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(options: AtlaSentClientOptions) {
    if (!options?.apiKey) {
      throw new AtlaSentError('apiKey is required');
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 10_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  #buildHeaders(requestId: string): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'User-Agent': buildUserAgent(),
      'X-Request-ID': requestId,
    };
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let res: Response;
    try {
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'POST',
        headers: this.#buildHeaders(requestId),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (
        err instanceof DOMException &&
        (err.name === 'TimeoutError' || err.name === 'AbortError')
      ) {
        throw new AtlaSentError('Request timed out', { code: 'timeout', cause: err });
      }
      throw new AtlaSentError(
        err instanceof Error ? err.message : 'Network error',
        { code: 'network', cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let serverMessage: string | undefined;
      try {
        const errBody = await res.json();
        if (typeof errBody?.message === 'string') serverMessage = errBody.message;
      } catch { /* non-JSON error body */ }

      if (res.status === 401) {
        throw new AtlaSentError('Invalid API key', { status: 401, code: 'invalid_api_key', requestId });
      }
      if (res.status === 403) {
        throw new AtlaSentError('Forbidden', { status: 403, code: 'forbidden', requestId });
      }
      if (res.status === 429) {
        throw new AtlaSentError('Rate limited', {
          status: 429,
          code: 'rate_limited',
          requestId,
          retryAfterMs: parseRetryAfter(res.headers),
        });
      }
      if (res.status >= 500) {
        throw new AtlaSentError('Server error', { status: res.status, code: 'server_error', requestId });
      }
      throw new AtlaSentError(serverMessage ?? 'Bad request', { status: res.status, code: 'bad_request', requestId });
    }

    let json: unknown;
    try {
      json = await res.json();
    } catch (err) {
      throw new AtlaSentError('Invalid JSON in response', { code: 'bad_response', cause: err });
    }
    return json as T;
  }

  async evaluate(req: EvaluateRequest): Promise<EvaluateResponse> {
    const wire = await this.#post<EvaluateWire>('/v1-evaluate', {
      action: req.action,
      agent: req.agent,
      context: req.context ?? {},
      api_key: this.#apiKey,
    });

    if (
      typeof wire?.permitted !== 'boolean' ||
      typeof wire?.decision_id !== 'string' ||
      typeof wire?.audit_hash !== 'string' ||
      typeof wire?.timestamp !== 'string'
    ) {
      throw new AtlaSentError('Missing required fields in evaluate response', { code: 'bad_response' });
    }

    return {
      decision: wire.permitted ? 'ALLOW' : 'DENY',
      permitId: wire.decision_id,
      reason: wire.reason ?? '',
      auditHash: wire.audit_hash,
      timestamp: wire.timestamp,
    };
  }

  async verifyPermit(req: VerifyPermitRequest): Promise<VerifyPermitResponse> {
    const body: Record<string, unknown> = {
      decision_id: req.permitId,
      api_key: this.#apiKey,
    };
    if (req.action !== undefined) body.action = req.action;
    if (req.agent !== undefined) body.agent = req.agent;
    if (req.context !== undefined) body.context = req.context;

    const wire = await this.#post<VerifyWire>('/v1-verify-permit', body);

    if (
      typeof wire?.verified !== 'boolean' ||
      typeof wire?.outcome !== 'string' ||
      typeof wire?.permit_hash !== 'string' ||
      typeof wire?.timestamp !== 'string'
    ) {
      throw new AtlaSentError('Missing required fields in verifyPermit response', { code: 'bad_response' });
    }

    return {
      verified: wire.verified,
      outcome: wire.outcome,
      permitHash: wire.permit_hash,
      timestamp: wire.timestamp,
    };
  }
}
