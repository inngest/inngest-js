import { context, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  type Instrumentation,
  registerInstrumentations,
} from "@opentelemetry/instrumentation";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { InngestSpanProcessor } from "./processor.ts";

export type Behaviour = "createProvider" | "extendProvider" | "off" | "auto";
export type Instrumentations = (Instrumentation | Instrumentation[])[];

export const createProvider = (
  _behaviour: Behaviour,
  instrumentations: Instrumentations | undefined = [],
): { success: true; processor: InngestSpanProcessor } | { success: false } => {
  // TODO Check if there's an existing provider
  const processor = new InngestSpanProcessor();

  const p = new BasicTracerProvider({
    spanProcessors: [processor],
  });

  const instrList: Instrumentations = [
    ...instrumentations,
    ...getNodeAutoInstrumentations(),
    new AnthropicInstrumentation(),
  ];

  registerInstrumentations({
    instrumentations: instrList,
  });

  trace.setGlobalTracerProvider(p);
  context.setGlobalContextManager(new AsyncHooksContextManager().enable());

  return { success: true, processor };
};

/**
 * Attempts to extend the existing OTel provider with our processor. Returns true
 * if the provider was extended, false if it was not.
 */
export const extendProvider = (
  behaviour: Behaviour,
): { success: true; processor: InngestSpanProcessor } | { success: false } => {
  // Attempt to add our processor and export to the existing provider
  const globalProvider = trace.getTracerProvider();
  if (!globalProvider) {
    if (behaviour !== "auto") {
      console.warn(
        'No existing OTel provider found and behaviour is "extendProvider". Inngest\'s OTel middleware will not work. Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.',
      );
    }

    return { success: false };
  }

  // trace.getTracerProvider() returns a ProxyTracerProvider wrapper
  // Unwrap it to get the actual provider.
  const existingProvider =
    "getDelegate" in globalProvider &&
    typeof globalProvider.getDelegate === "function"
      ? globalProvider.getDelegate()
      : globalProvider;

  if (!existingProvider) {
    if (behaviour !== "auto") {
      console.warn(
        "Existing OTel provider is not a BasicTracerProvider. Inngest's OTel middleware will not work, as it can only extend an existing processor if it's a BasicTracerProvider.",
      );
    }

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

  // OTel SDK v2 removed addSpanProcessor() — span processors are constructor-only.
  // No public API exists to add processors post-construction (OTel issue #5299),
  // so push into the internal _spanProcessors array.
  // These fields are TypeScript `private` (not #private), so accessible at runtime.
  const spanProcessors = getInternalSpanProcessors(existingProvider);
  if (spanProcessors) {
    spanProcessors.push(processor);
    return { success: true, processor };
  }

  if (behaviour !== "auto") {
    console.warn(
      "Unable to add InngestSpanProcessor to existing OTel provider. " +
        "The provider does not support addSpanProcessor() (OTel SDK v1) " +
        "or expose _activeSpanProcessor._spanProcessors (OTel SDK v2).",
    );
  }

  return { success: false };
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
function getInternalSpanProcessors(
  provider: unknown,
): unknown[] | undefined {
  try {
    const active = (provider as Record<string, unknown>)
      ?._activeSpanProcessor;
    if (typeof active !== "object" || active === null) return undefined;

    const arr = (active as Record<string, unknown>)._spanProcessors;
    return Array.isArray(arr) ? arr : undefined;
  } catch {
    return undefined;
  }
}
