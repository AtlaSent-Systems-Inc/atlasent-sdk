"""Optional OpenTelemetry tracing. Gracefully no-ops if opentelemetry is not installed."""
from __future__ import annotations
import functools
from typing import Any, Callable

try:
    from opentelemetry import trace
    from opentelemetry.trace import SpanKind
    _OTEL_AVAILABLE = True
except ImportError:
    _OTEL_AVAILABLE = False


def get_tracer() -> Any:
    if not _OTEL_AVAILABLE:
        return None
    return trace.get_tracer("atlasent-sdk", "1.1.0")


def traced_authorize(fn: Callable) -> Callable:
    """Wrap authorize() with an OTel span when opentelemetry is available."""
    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        tracer = get_tracer()
        if tracer is None:
            return fn(*args, **kwargs)
        action = kwargs.get("action") or (args[1] if len(args) > 1 else "unknown")
        with tracer.start_as_current_span(
            "atlasent.authorize",
            kind=SpanKind.CLIENT,
            attributes={"atlasent.action": str(action)},
        ) as span:
            result = fn(*args, **kwargs)
            span.set_attribute("atlasent.decision", result.get("decision", "unknown"))
            return result
    return wrapper
