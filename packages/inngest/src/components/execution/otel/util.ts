import { context, trace } from "@opentelemetry/api";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import {
  BasicTracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import { debugPrefix } from "./consts.ts";
import { InngestSpanProcessor } from "./processor.ts";

const debug = Debug(`${debugPrefix}:createProvider`);

export type Behaviour = "createProvider" | "extendProvider" | "off" | "auto";
export type Instrumentations = (Instrumentation | Instrumentation[])[];

const getExistingProvider = () => {
  const globalProvider = trace.getTracerProvider();
  if (!globalProvider) {
    return undefined;
  }

  return "getDelegate" in globalProvider &&
    typeof globalProvider.getDelegate === "function"
    ? globalProvider.getDelegate()
    : globalProvider;
};

export const createProvider = async (
  _behaviour: Behaviour,
  instrumentations: Instrumentations | undefined = [],
): Promise<
  | { success: true; processor: InngestSpanProcessor }
  | { success: false; error?: unknown }
> => {
  try {
    // TODO Check if there's an existing provider
    const processor = new InngestSpanProcessor();

    // Dynamic imports to avoid loading the full auto-instrumentation suite at
    // module evaluation time. These are only needed when creating a new provider,
    // not when extending an existing one. Static imports here caused version
    // conflicts with host app OTel setups (e.g. Sentry) and silently broke
    // inngest.send(). See #1324.
    const { getNodeAutoInstrumentations } = await import(
      "@opentelemetry/auto-instrumentations-node"
    );
    const { registerInstrumentations } = await import(
      "@opentelemetry/instrumentation"
    );
    const { AnthropicInstrumentation } = await import(
      "@traceloop/instrumentation-anthropic"
    );
    const { AsyncHooksContextManager } = await import(
      "@opentelemetry/context-async-hooks"
    );

    const instrList: Instrumentations = [
      ...instrumentations,
      ...getNodeAutoInstrumentations(),
      new AnthropicInstrumentation(),
    ];

    registerInstrumentations({
      instrumentations: instrList,
    });

    const extended = extendProviderWithProcessor(processor, "auto");
    if (extended.success) {
      return { success: true, processor };
    }

    const p = new BasicTracerProvider({
      spanProcessors: [processor],
    });

    if (!trace.setGlobalTracerProvider(p)) {
      const retryExtended = extendProviderWithProcessor(processor, "auto");
      if (retryExtended.success) {
        return { success: true, processor };
      }

      return {
        success: false,
        error: new Error("Unable to set or extend global OTel provider"),
      };
    }

    context.setGlobalContextManager(new AsyncHooksContextManager().enable());

    return { success: true, processor };
  } catch (err) {
    debug("failed to create provider:", err);
    return { success: false, error: err };
  }
};

export const createProviderWithProcessor = async (
  processor: SpanProcessor,
): Promise<{ success: true } | { success: false; error?: unknown }> => {
  try {
    const extended = extendProviderWithProcessor(processor, "auto");
    if (extended.success) {
      return { success: true };
    }

    const { AsyncHooksContextManager } = await import(
      "@opentelemetry/context-async-hooks"
    );

    const p = new BasicTracerProvider({
      spanProcessors: [processor],
    });

    const retryExtended = extendProviderWithProcessor(processor, "auto");
    if (retryExtended.success) {
      return { success: true };
    }

    if (!trace.setGlobalTracerProvider(p)) {
      const finalExtended = extendProviderWithProcessor(processor, "auto");
      if (finalExtended.success) {
        return { success: true };
      }

      return {
        success: false,
        error: new Error("Unable to set or extend global OTel provider"),
      };
    }

    context.setGlobalContextManager(new AsyncHooksContextManager().enable());

    return { success: true };
  } catch (err) {
    debug("failed to create provider:", err);
    return { success: false, error: err };
  }
};

/**
 * Attempts to extend the existing OTel provider with our processor. Returns true
 * if the provider was extended, false if it was not.
 */
export const extendProvider = (
  behaviour: Behaviour,
): { success: true; processor: InngestSpanProcessor } | { success: false } => {
  const processor = new InngestSpanProcessor();
  const extended = extendProviderWithProcessor(
    processor,
    behaviour,
    "InngestSpanProcessor",
  );

  if (!extended.success) {
    return { success: false };
  }

  return { success: true, processor };
};

export const extendProviderWithProcessor = (
  processor: SpanProcessor,
  behaviour: Behaviour,
  processorName = "span processor",
): { success: true } | { success: false } => {
  // Attempt to add our processor and export to the existing provider
  const existingProvider = getExistingProvider();
  if (!existingProvider) {
    if (behaviour !== "auto") {
      console.warn(
        'No existing OTel provider found and behaviour is "extendProvider". Inngest\'s OTel middleware will not work. Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.',
      );
    }

    return { success: false };
  }

  // OTel SDK v1 exposes addSpanProcessor() on BasicTracerProvider.
  if (
    "addSpanProcessor" in existingProvider &&
    typeof existingProvider.addSpanProcessor === "function"
  ) {
    existingProvider.addSpanProcessor(processor);
    return { success: true };
  }

  // OTel SDK v2 removed addSpanProcessor() — span processors are constructor-only.
  // No public API exists to add processors post-construction (OTel issue #5299),
  // so push into the internal _spanProcessors array.
  // These fields are TypeScript `private` (not #private), so accessible at runtime.
  const spanProcessors = getInternalSpanProcessors(existingProvider);
  if (spanProcessors) {
    spanProcessors.push(processor);
    return { success: true };
  }

  if (behaviour !== "auto") {
    console.warn(
      `Unable to add ${processorName} to existing OTel provider. ` +
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
function getInternalSpanProcessors(provider: unknown): unknown[] | undefined {
  try {
    const active = (provider as Record<string, unknown>)?._activeSpanProcessor;
    if (typeof active !== "object" || active === null) return undefined;

    const arr = (active as Record<string, unknown>)._spanProcessors;
    return Array.isArray(arr) ? arr : undefined;
  } catch {
    return undefined;
  }
}
