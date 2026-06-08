import { trace } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";

/**
 * Lightweight helpers for attaching a span processor to an already-registered
 * global OTel provider.
 *
 * Kept deliberately free of any `@opentelemetry/sdk-trace-base` *value* imports
 * (only `@opentelemetry/api`, which the core SDK already loads) so that the core
 * client path can attach a processor without pulling the OTel SDK, exporter, or
 * resource-detection libraries into a plain Inngest app's module graph.
 */

/**
 * Attempts to add the given span processor to the existing global OTel
 * provider. Returns `true` if the processor was attached, `false` if there was
 * no suitable provider to extend.
 *
 * This is extend-only: it never creates a provider, imports instrumentation, or
 * touches any other global OTel state, so it is safe to call by default. It
 * handles both OTel SDK v1 (`addSpanProcessor()`) and v2 (internal
 * `_spanProcessors` array).
 */
export const attachToGlobalProvider = (processor: SpanProcessor): boolean => {
  const globalProvider = trace.getTracerProvider();
  if (!globalProvider) {
    return false;
  }

  // trace.getTracerProvider() returns a ProxyTracerProvider wrapper
  // Unwrap it to get the actual provider.
  const existingProvider =
    "getDelegate" in globalProvider &&
    typeof globalProvider.getDelegate === "function"
      ? globalProvider.getDelegate()
      : globalProvider;

  if (!existingProvider) {
    return false;
  }

  // OTel SDK v1 exposes addSpanProcessor() on BasicTracerProvider.
  if (
    "addSpanProcessor" in existingProvider &&
    typeof (existingProvider as { addSpanProcessor?: unknown })
      .addSpanProcessor === "function"
  ) {
    (
      existingProvider as unknown as {
        addSpanProcessor: (p: SpanProcessor) => void;
      }
    ).addSpanProcessor(processor);
    return true;
  }

  // OTel SDK v2 removed addSpanProcessor() — span processors are constructor-only.
  // No public API exists to add processors post-construction (OTel issue #5299),
  // so push into the internal _spanProcessors array.
  // These fields are TypeScript `private` (not #private), so accessible at runtime.
  const spanProcessors = getInternalSpanProcessors(existingProvider);
  if (spanProcessors) {
    spanProcessors.push(processor);
    return true;
  }

  return false;
};

/**
 * Extract the internal span processors array from a BasicTracerProvider.
 * Returns the mutable array if accessible, undefined otherwise.
 *
 * BasicTracerProvider._activeSpanProcessor is a MultiSpanProcessor,
 * which holds a _spanProcessors: SpanProcessor[] array.
 * Both are TypeScript `private` (not ES #private), so accessible at runtime.
 *
 * Wrapped in try/catch because this accesses internal OTel fields that may
 * change — must never crash the host app.
 */
export function getInternalSpanProcessors(
  provider: unknown,
): unknown[] | undefined {
  try {
    const active = (provider as Record<string, unknown>)?._activeSpanProcessor;
    if (typeof active !== "object" || active === null) return undefined;

    const arr = (active as Record<string, unknown>)._spanProcessors;
    return Array.isArray(arr) ? arr : undefined;
  } catch {
    return undefined;
  }
}
