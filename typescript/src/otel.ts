type Span = { end(): void; setAttribute(k: string, v: unknown): void; recordException(e: unknown): void; setStatus(s: { code: number; message?: string }): void };
type Tracer = { startSpan(name: string): Span };

let tracer: Tracer | undefined;

export function configureTracing(t: Tracer) { tracer = t; }

export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> {
  if (!tracer) return fn({ end() {}, setAttribute() {}, recordException() {}, setStatus() {} });
  const span = tracer.startSpan(name);
  try {
    const result = await fn(span);
    span.setStatus({ code: 1 });
    return result;
  } catch (e) {
    span.recordException(e);
    span.setStatus({ code: 2, message: e instanceof Error ? e.message : String(e) });
    throw e;
  } finally {
    span.end();
  }
}
