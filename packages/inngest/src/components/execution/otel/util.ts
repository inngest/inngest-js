import { trace } from "@opentelemetry/api";
import { InngestSpanProcessor } from "./processor.ts";

/**
 * Attempts to extend the existing OTel provider with our processor. Returns true
 * if the provider was extended, false if it was not.
 */
export function extendProvider():
  | { success: true; processor: InngestSpanProcessor }
  | { success: false } {
  // Attempt to add our processor and export to the existing provider
  const globalProvider = trace.getTracerProvider();
  if (!globalProvider) {
    console.warn(
      "No existing OTel provider found. Extended Traces will not work. Call instrumentTraces() before creating your Inngest client, or set up your own provider before using extendedTracesMiddleware().",
    );

    return { success: false };
  }

  // trace.getTracerProvider() returns a ProxyTracerProvider wrapper
  // Unwrap it to get the actual provider.
  let existingProvider: unknown = globalProvider;
  if (
    "getDelegate" in globalProvider &&
    typeof globalProvider.getDelegate === "function"
  ) {
    existingProvider = globalProvider.getDelegate();
  }

  if (!existingProvider) {
    console.warn(
      "Existing OTel provider is not a BasicTracerProvider. Extended Traces will not work, as it can only extend an existing processor if it's a BasicTracerProvider.",
    );

    return { success: false };
  }

  if (typeof existingProvider !== "object") {
    console.warn(
      "Existing OTel provider is not a BasicTracerProvider. Extended Traces will not work, as it can only extend an existing processor if it's a BasicTracerProvider.",
    );

    return { success: false };
  }

  const processor = new InngestSpanProcessor();

  // OTel SDK v1 exposes addSpanProcessor() on BasicTracerProvider.
  if (
    "addSpanProcessor" in existingProvider &&
    typeof existingProvider.addSpanProcessor === "function"
  ) {
    existingProvider.addSpanProcessor(processor);
    return { success: true, processor };
  }

  // OTel SDK v2 removed addSpanProcessor(); span processors are constructor-only.
  // No public API exists to add processors post-construction (OTel issue #5299),
  // so push into the internal _spanProcessors array.
  // These fields are TypeScript `private` (not #private), so accessible at runtime.
  const spanProcessors = getInternalSpanProcessors(existingProvider);
  if (spanProcessors) {
    spanProcessors.push(processor);
    return { success: true, processor };
  }

  console.warn(
    "Unable to add InngestSpanProcessor to existing OTel provider. " +
      "The provider does not support addSpanProcessor() (OTel SDK v1) " +
      "or expose _activeSpanProcessor._spanProcessors (OTel SDK v2).",
  );

  return { success: false };
}

/**
 * Extract the internal span processors array from a BasicTracerProvider.
 * Returns the mutable array if accessible, undefined otherwise.
 *
 * BasicTracerProvider._activeSpanProcessor is a MultiSpanProcessor,
 * which holds a _spanProcessors: SpanProcessor[] array.
 * Both are TypeScript `private` (not ES #private), so accessible at runtime.
 *
 * Wrapped in try/catch because this accesses internal OTel fields that may
 * change, so this must never crash the host app.
 */
function getInternalSpanProcessors(provider: unknown): unknown[] | undefined {
  try {
    if (typeof provider !== "object" || provider === null) {
      return undefined;
    }

    if (!("_activeSpanProcessor" in provider)) {
      return undefined;
    }

    const active = provider._activeSpanProcessor;
    if (typeof active !== "object" || active === null) {
      return undefined;
    }

    if (!("_spanProcessors" in active)) {
      return undefined;
    }

    const arr = active._spanProcessors;
    if (Array.isArray(arr)) {
      return arr;
    }

    return undefined;
  } catch {
    return undefined;
  }
}
