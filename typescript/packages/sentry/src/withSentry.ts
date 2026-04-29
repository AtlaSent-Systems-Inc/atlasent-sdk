/**
 * Wrap an `AtlaSentClient` with Sentry breadcrumb emission.
 *
 * Each public method on the returned wrapper runs the original
 * `AtlaSentClient` call after first emitting a Sentry breadcrumb
 * (and, when `captureErrors: true`, capturing exceptions on throw).
 *
 * Breadcrumb shape follows Sentry's conventions:
 *   - `category: "atlasent"` for filtering / search
 *   - `message: "<method_name>"` (snake_case for grep-ability)
 *   - `level: "info"` on success, `"error"` on failure
 *   - `data: {...}` namespaced under our wire fields plus `extraData`
 *
 * The wrapper does NOT touch v1. It depends only on the documented
 * public API of `@atlasent/sdk`. v1 ships unchanged.
 */

import {
  addBreadcrumb,
  captureException,
  type Breadcrumb,
} from "@sentry/core";
import type { AtlaSentClient } from "@atlasent/sdk";
import type {
  AuditExportRequest,
  AuditEventsResult,
  AuditExportResult,
  ApiKeySelfResponse,
  EvaluateRequest,
  EvaluateResponse,
  OnRetryContext,
  VerifyPermitRequest,
  VerifyPermitResponse,
} from "@atlasent/sdk";

/** Constructor options for {@link withSentry}. */
export interface WithSentryOptions {
  /**
   * Extra fields added to every breadcrumb's `data`. Useful for
   * `service` / `tenant` / deployment tags. Per-call fields
   * (`agent`, `action`, etc.) layer on top.
   */
  extraData?: Record<string, unknown>;
  /**
   * Also call `Sentry.captureException(err)` on throw. Defaults to
   * `false` — most apps capture exceptions at a higher layer (a
   * route handler, an error boundary). Flipping this on opts in to
   * per-call capture, useful for fire-and-forget background jobs
   * where the error isn't naturally caught upstream.
   */
  captureErrors?: boolean;
}

/**
 * The minimal public surface of {@link AtlaSentClient} that this
 * wrapper exercises. Re-declared so the wrapper compiles even
 * before v1 publishes.
 */
export interface SentryInstrumentedClient {
  evaluate(input: EvaluateRequest): Promise<EvaluateResponse>;
  verifyPermit(input: VerifyPermitRequest): Promise<VerifyPermitResponse>;
  keySelf(): Promise<ApiKeySelfResponse>;
  listAuditEvents(query?: AuditExportRequest): Promise<AuditEventsResult>;
  createAuditExport(filter?: AuditExportRequest): Promise<AuditExportResult>;
}

/**
 * Wrap a v1 client with Sentry breadcrumbs. Returns a new object
 * that delegates every call to the underlying client and emits one
 * breadcrumb per invocation.
 *
 * @example
 *   import * as Sentry from "@sentry/node";
 *   Sentry.init({ dsn: "..." });
 *   const client = withSentry(new AtlaSentClient({ apiKey }), {
 *     extraData: { service: "deploy-bot" },
 *   });
 *   await client.evaluate({ agent, action, context });
 */
export function withSentry(
  client: AtlaSentClient,
  options: WithSentryOptions = {},
): SentryInstrumentedClient {
  const baseData = options.extraData ?? {};
  const captureErrors = options.captureErrors ?? false;

  return {
    async evaluate(input) {
      return runWithBreadcrumb(
        "evaluate",
        { ...baseData, agent: input.agent, action: input.action },
        captureErrors,
        async () => {
          const result = await client.evaluate(input);
          return [
            result,
            {
              decision: result.decision,
              permit_id: result.permitId,
              audit_hash: result.auditHash,
            },
          ];
        },
      );
    },

    async verifyPermit(input) {
      return runWithBreadcrumb(
        "verify_permit",
        { ...baseData, permit_id: input.permitId },
        captureErrors,
        async () => {
          const result = await client.verifyPermit(input);
          return [result, { verified: result.verified }];
        },
      );
    },

    async keySelf() {
      return runWithBreadcrumb(
        "key_self",
        { ...baseData },
        captureErrors,
        async () => {
          const result = await client.keySelf();
          return [
            result,
            { key_id: result.keyId, environment: result.environment },
          ];
        },
      );
    },

    async listAuditEvents(query) {
      return runWithBreadcrumb(
        "list_audit_events",
        { ...baseData },
        captureErrors,
        async () => {
          const result = await client.listAuditEvents(
            query as Parameters<AtlaSentClient["listAuditEvents"]>[0],
          );
          return [result, { event_count: result.events.length }];
        },
      );
    },

    async createAuditExport(filter) {
      return runWithBreadcrumb(
        "create_audit_export",
        { ...baseData },
        captureErrors,
        async () => {
          const result = await client.createAuditExport(filter);
          const succeed: Record<string, unknown> = {};
          if (result.export_id) succeed.export_id = result.export_id;
          if (result.events) succeed.event_count = result.events.length;
          return [result, succeed];
        },
      );
    },
  };
}

/** Options for {@link wrapProtect}. */
export interface WrapProtectOptions extends WithSentryOptions {
  /** The v1 `protect` function imported from `@atlasent/sdk`. */
  protect: <TInput extends { agent: string; action: string }>(
    input: TInput,
  ) => Promise<unknown>;
}

/**
 * Wrap the top-level v1 `protect()` function with Sentry breadcrumbs.
 *
 * @example
 *   import { protect } from "@atlasent/sdk";
 *   const protectWithSentry = wrapProtect({ protect });
 *   await protectWithSentry({ agent, action, context });
 */
export function wrapProtect<
  TInput extends { agent: string; action: string },
  TResult,
>(options: WithSentryOptions & {
  protect: (input: TInput) => Promise<TResult>;
}): (input: TInput) => Promise<TResult> {
  const baseData = options.extraData ?? {};
  const captureErrors = options.captureErrors ?? false;

  return async (input: TInput): Promise<TResult> => {
    return runWithBreadcrumb(
      "protect",
      { ...baseData, agent: input.agent, action: input.action },
      captureErrors,
      async () => {
        const result = await options.protect(input);
        const successData: Record<string, unknown> = {};
        if (result && typeof result === "object") {
          const r = result as Record<string, unknown>;
          if (typeof r.permit_id === "string") successData.permit_id = r.permit_id;
          if (typeof r.audit_hash === "string") successData.audit_hash = r.audit_hash;
        }
        return [result, successData];
      },
    );
  };
}

// ─── Internals ────────────────────────────────────────────────────────

async function runWithBreadcrumb<T>(
  message: string,
  preCallData: Record<string, unknown>,
  captureErrors: boolean,
  action: () => Promise<[T, Record<string, unknown>]>,
): Promise<T> {
  try {
    const [result, postCallData] = await action();
    addBreadcrumb({
      category: "atlasent",
      message,
      level: "info",
      data: { ...preCallData, ...postCallData },
    } satisfies Breadcrumb);
    return result;
  } catch (err) {
    addBreadcrumb({
      category: "atlasent",
      message,
      level: "error",
      data: { ...preCallData, ...errorData(err) },
    } satisfies Breadcrumb);
    if (captureErrors) {
      captureException(err);
    }
    throw err;
  }
}

/**
 * Returns an `onRetry` callback for {@link AtlaSentClientOptions} that
 * emits a Sentry breadcrumb before each retry sleep.
 *
 * @example
 *   const client = new AtlaSentClient({
 *     apiKey,
 *     onRetry: makeSentryOnRetry({ service: "deploy-bot" }),
 *   });
 */
export function makeSentryOnRetry(
  extraData?: Record<string, unknown>,
): (ctx: OnRetryContext) => void {
  return (ctx: OnRetryContext) => {
    addBreadcrumb({
      category: "atlasent",
      message: "retry",
      level: "warning",
      data: {
        ...extraData,
        attempt: ctx.attempt,
        delay_ms: ctx.delayMs,
        path: ctx.path,
        ...errorData(ctx.error),
      },
    } satisfies Breadcrumb);
  };
}

function errorData(err: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (err instanceof Error) {
    out.error_message = err.message;
  }
  if (err && typeof err === "object") {
    if ("code" in err && typeof (err as { code: unknown }).code === "string") {
      out.error_code = (err as { code: string }).code;
    }
    if (
      "requestId" in err &&
      typeof (err as { requestId: unknown }).requestId === "string"
    ) {
      out.request_id = (err as { requestId: string }).requestId;
    }
  }
  return out;
}
