import type { Tracer } from '@opentelemetry/api';

export interface TracingOptions {
  tracer: Tracer;
}

export async function withSpan<T>(
  tracer: Tracer | undefined,
  name: string,
  attrs: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!tracer) return fn();
  const span = tracer.startSpan(name, { attributes: attrs });
  try {
    const result = await fn();
    span.setStatus({ code: 1 }); // OK
    return result;
  } catch (err) {
    span.setStatus({ code: 2, message: String(err) }); // ERROR
    throw err;
  } finally {
    span.end();
  }
}
