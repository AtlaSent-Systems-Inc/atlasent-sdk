import { createHmac, randomBytes } from "node:crypto";
import type { BehaviorEmitOptions, BvsEvent, BvsSource, EmitResult } from "./types.js";
import { assertNoRawText } from "./privacy.js";

export class BvsEmitError extends Error {
  constructor(
    public readonly status: number,
    public readonly responseBody: string,
  ) {
    super(`BVS emit failed: HTTP ${status} — ${responseBody.slice(0, 200)}`);
    this.name = "BvsEmitError";
  }
}

function sign(secret: string, timestamp: number, nonce: string, body: string): string {
  return (
    "sha256=" +
    createHmac("sha256", secret)
      .update(`${timestamp}.${nonce}.${body}`)
      .digest("hex")
  );
}

export interface BehaviorEmitter {
  emit(source: BvsSource, event: BvsEvent): Promise<EmitResult>;
}

export function createBehaviorEmitter(opts: BehaviorEmitOptions): BehaviorEmitter {
  const endpoint = opts.endpoint.replace(/\/$/, "");
  const timeoutMs = opts.timeoutMs ?? 10_000;

  return {
    async emit(source: BvsSource, event: BvsEvent): Promise<EmitResult> {
      assertNoRawText(event);

      const body = JSON.stringify({ ...event, source });
      const timestamp = Math.floor(Date.now() / 1000);
      const nonce = randomBytes(16).toString("hex");

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-BVS-Signature": sign(opts.hmacSecret, timestamp, nonce, body),
        "X-BVS-Timestamp": String(timestamp),
        "X-BVS-Nonce": nonce,
      };
      if (opts.serviceToken) {
        headers["Authorization"] = `Bearer ${opts.serviceToken}`;
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);

      try {
        const res = await fetch(`${endpoint}/api/internal/${source}/events`, {
          method: "POST",
          headers,
          body,
          signal: ac.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new BvsEmitError(res.status, text);
        }

        return { ok: true, status: res.status };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
