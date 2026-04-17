import {
  AtlaSentAPIError,
  AtlaSentDeniedError,
  AtlaSentEscalateError,
  AtlaSentHoldError,
} from "./errors.js";
import type {
  AtlaSentClientOptions,
  EvaluateRequest,
  EvaluateResponse,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "./types.js";
import { EvaluateResponseSchema, VerifyPermitResponseSchema } from "./types.js";

export class AtlaSentClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeout: number;

  constructor({ apiKey, baseUrl = "https://api.atlasent.io", timeout = 10_000 }: AtlaSentClientOptions) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.timeout = timeout;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeout);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new AtlaSentAPIError(res.status, text);
      return JSON.parse(text) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  async evaluate(req: EvaluateRequest): Promise<EvaluateResponse> {
    const raw = await this.post<unknown>("/v1/evaluate", req);
    return EvaluateResponseSchema.parse(raw);
  }

  async authorizeOrThrow(req: EvaluateRequest): Promise<EvaluateResponse> {
    const resp = await this.evaluate(req);
    if (resp.decision === "deny") {
      throw new AtlaSentDeniedError(resp.denyCode ?? "DENIED", resp);
    }
    if (resp.decision === "hold") {
      throw new AtlaSentHoldError(resp.denyCode ?? "HOLD", resp);
    }
    if (resp.decision === "escalate") {
      throw new AtlaSentEscalateError(resp.escalateTo ?? "", resp);
    }
    return resp;
  }

  async verifyPermit(req: VerifyPermitRequest): Promise<VerifyPermitResponse> {
    const raw = await this.post<unknown>("/v1/verify-permit", req);
    return VerifyPermitResponseSchema.parse(raw);
  }
}
