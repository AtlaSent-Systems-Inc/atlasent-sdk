/**
 * Wrap an `AtlaSentClient` with automatic OpenTelemetry span creation.
 *
 * Each public method on the returned wrapper runs the original
 * `AtlaSentClient` call inside a span. Span name + attributes follow
 * the OTel semantic-convention pattern of `service.method` style:
 *
 *   - `atlasent.evaluate`
 *   - `atlasent.verify_permit`
 *   - `atlasent.protect`
 *   - `atlasent.key_self`
 *   - `atlasent.list_audit_events`
 *   - `atlasent.create_audit_export`
 *
 * The wrapper does NOT touch v1. It depends only on the documented
 * public API of `@atlasent/sdk`. v1 ships unchanged.
 */

import {
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { AtlaSentClient } from "@atlasent/sdk";
import type {
  AtlaSentClientOptions,
  EvaluateRequest,
  EvaluateResponse,
  VerifyPermitRequest,
  VerifyPermitResponse,
  ApiKeySelfResponse,
  AuditEventsResult,
  AuditExportRequest,
  AuditExportResult,
} from "@atlasent/sdk";

/** Constructor options for {@link withOtel}. */
export interface WithOtelOptions {
  /** OpenTelemetry tracer obtained from `trace.getTracer(...)`. */
  tracer: Tracer;
  /**
   * Optional attributes added to every span. Useful for
   * `service.name`, `deployment.environment`, tenant tags, etc.
   * Span-specific attributes (`atlasent.agent`, etc.) are layered
   * on top per-call and override these on collision.
   */
  attributes?: Attributes;
  /**
   * Override the span name prefix. Defaults to `"atlasent."`. Useful
   * if you want every AtlaSent span to live under your service name
   * (`"my-svc.atlasent."`).
   */
  spanNamePrefix?: string;
}

/**
 * The minimal public surface of {@link AtlaSentClient} that this
 * wrapper exercises. Re-declared explicitly so the wrapper compiles
 * even before v1 publishes — the type-only import is satisfied by
 * the `@atlasent/sdk` peer dep at runtime.
 */
export interface OtelInstrumentedClient {
  evaluate(input: EvaluateRequest): Promise<EvaluateResponse>;
  verifyPermit(input: VerifyPermitRequest): Promise<VerifyPermitResponse>;
  keySelf(): Promise<ApiKeySelfResponse>;
  listAuditEvents(query?: AuditExportRequest): Promise<AuditEventsResult>;
  createAuditExport(filter?: AuditExportRequest): Promise<AuditExportResult>;
}

/**
 * Wrap a v1 client with OTel spans. Returns a new object that
 * delegates every call to the underlying client and emits one span
 * per invocation.
 *
 * @example
 *   const tracer = trace.getTracer("my-app");
 *   const client = withOtel(new AtlaSentClient({ apiKey }), { tracer });
 *   await client.evaluate({ agent, action, context });
 */
export function withOtel(
  client: AtlaSentClient,
  options: WithOtelOptions,
): OtelInstrumentedClient {
  const tracer = options.tracer;
  const baseAttrs = options.attributes ?? {};
  const prefix = options.spanNamePrefix ?? "atlasent.";

  return {
    async evaluate(input) {
      return runInSpan(
        tracer,
        `${prefix}evaluate`,
        {
          ...baseAttrs,
          "atlasent.agent": input.agent,
          "atlasent.action": input.action,
        },
        async (span) => {
          const result = await client.evaluate(input);
          span.setAttribute("atlasent.decision", result.decision);
          if (result.permitId) {
            span.setAttribute("atlasent.permit_id", result.permitId);
          }
          if (result.auditHash) {
            span.setAttribute("atlasent.audit_hash", result.auditHash);
          }
          return result;
        },
      );
    },

    async verifyPermit(input) {
      return runInSpan(
        tracer,
        `${prefix}verify_permit`,
        {
          ...baseAttrs,
          "atlasent.permit_id": input.permitId,
        },
        async (span) => {
          const result = await client.verifyPermit(input);
          span.setAttribute("atlasent.verified", result.verified);
          return result;
        },
      );
    },

    async keySelf() {
      return runInSpan(
        tracer,
        `${prefix}key_self`,
        baseAttrs,
        async (span) => {
          const result = await client.keySelf();
          span.setAttribute("atlasent.key_id", result.keyId);
          span.setAttribute("atlasent.environment", result.environment);
          return result;
        },
      );
    },

    async listAuditEvents(query) {
      return runInSpan(
        tracer,
        `${prefix}list_audit_events`,
        baseAttrs,
        async (span) => {
          // `query` is `AuditExportRequest`-compatible; the v1 SDK accepts
          // the broader shape. Pass through verbatim so callers retain the
          // same options surface as the wrapped client.
          const result = await client.listAuditEvents(
            query as Parameters<AtlaSentClient["listAuditEvents"]>[0],
          );
          span.setAttribute("atlasent.event_count", result.events.length);
          return result;
        },
      );
    },

    async createAuditExport(filter) {
      return runInSpan(
        tracer,
        `${prefix}create_audit_export`,
        baseAttrs,
        async (span) => {
          const result = await client.createAuditExport(filter);
          if (result.export_id) {
            span.setAttribute("atlasent.export_id", result.export_id);
          }
          if (result.events) {
            span.setAttribute("atlasent.event_count", result.events.length);
          }
          return result;
        },
      );
    },
  };
}

/**
 * Re-export of {@link withOtel} that also forwards `protect()`. Kept
 * separate because `protect()` is a top-level function in v1, not a
 * method on `AtlaSentClient` — wrapping it requires a different shape.
 */
export interface WithOtelProtectOptions extends WithOtelOptions {
  /** The v1 `protect` function imported from `@atlasent/sdk`. */
  protect: <T extends { agent: string; action: string }>(input: T) => Promise<unknown>;
}

/**
 * Wrap the top-level `protect()` function with OTel spans. Returns a
 * function with the same signature.
 *
 * @example
 *   import { protect } from "@atlasent/sdk";
 *   const protectWithOtel = wrapProtect({ tracer, protect });
 *   await protectWithOtel({ agent, action });
 */
export function wrapProtect<TInput extends { agent: string; action: string }, TResult>(
  options: WithOtelOptions & {
    protect: (input: TInput) => Promise<TResult>;
  },
): (input: TInput) => Promise<TResult> {
  const tracer = options.tracer;
  const baseAttrs = options.attributes ?? {};
  const prefix = options.spanNamePrefix ?? "atlasent.";

  return async (input: TInput): Promise<TResult> => {
    return runInSpan(
      tracer,
      `${prefix}protect`,
      {
        ...baseAttrs,
        "atlasent.agent": input.agent,
        "atlasent.action": input.action,
      },
      async (span) => {
        const result = await options.protect(input);
        // Permit shape: { permit_id, permit_hash, audit_hash, ... }
        if (result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          if (typeof r.permit_id === "string") {
            span.setAttribute("atlasent.permit_id", r.permit_id);
          }
          if (typeof r.audit_hash === "string") {
            span.setAttribute("atlasent.audit_hash", r.audit_hash);
          }
        }
        return result;
      },
    );
  };
}

/** Re-export so callers don't have to import twice. */
export type { AtlaSentClientOptions };

// ─── Internals ────────────────────────────────────────────────────────

async function runInSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(
    name,
    { kind: SpanKind.CLIENT, attributes },
    async (span) => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

function recordError(span: Span, err: unknown): void {
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err instanceof Error ? err.message : String(err),
  });
  if (err instanceof Error) {
    span.recordException(err);
  }
  // Surface AtlaSentError.code as a span attribute when present.
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "string") {
      span.setAttribute("atlasent.error_code", code);
    }
  }
  if (err && typeof err === "object" && "requestId" in err) {
    const requestId = (err as { requestId: unknown }).requestId;
    if (typeof requestId === "string") {
      span.setAttribute("atlasent.request_id", requestId);
    }
  }
}
