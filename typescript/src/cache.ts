/**
 * In-memory TTL cache for authorization decisions.
 *
 * Parity with the Python SDK's `atlasent.cache.TTLCache`: same key
 * derivation (sha256 over sorted-key JSON, truncated to 16 hex chars)
 * so a cache seeded by one SDK is addressable from the other.
 *
 * @example
 * const cache = new TTLCache({ ttlMs: 30_000 });
 * const client = new AtlaSentClient({ apiKey, cache });
 */

import { createHash } from "node:crypto";

import type { EvaluateResponse } from "./types.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_SIZE = 1024;

export interface TTLCacheOptions {
  /** Entry lifetime in ms. Defaults to 30_000 (30 s). */
  ttlMs?: number;
  /** Maximum number of entries. Oldest are evicted when full. Defaults to 1024. */
  maxSize?: number;
}

interface Entry {
  expiresAt: number;
  value: EvaluateResponse;
}

export class TTLCache {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly store = new Map<string, Entry>();

  constructor(options: TTLCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxSize = options.maxSize ?? DEFAULT_MAX_SIZE;
  }

  get(key: string): EvaluateResponse | undefined {
    const entry = this.store.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  put(key: string, value: EvaluateResponse): void {
    if (this.store.size >= this.maxSize) {
      this.evictExpired();
    }
    if (this.store.size >= this.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { expiresAt: Date.now() + this.ttlMs, value });
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) this.store.delete(key);
    }
  }

  /**
   * Deterministic cache key from evaluate() arguments. Matches the
   * Python implementation byte-for-byte so the same (action, agent,
   * context) tuple hashes identically in both SDKs.
   */
  static makeKey(
    action: string,
    agent: string,
    context: Record<string, unknown>,
  ): string {
    const canonical = JSON.stringify(
      { action_type: action, actor_id: agent, context },
      canonicalReplacer(),
    );
    return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  }
}

/**
 * JSON.stringify replacer that sorts object keys lexicographically so
 * the serialized form matches Python's `json.dumps(..., sort_keys=True)`.
 */
function canonicalReplacer(): (this: unknown, key: string, value: unknown) => unknown {
  return function (_key, value) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return value;
  };
}
