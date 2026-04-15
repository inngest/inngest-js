import { context, trace } from "@opentelemetry/api";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import { debugPrefix } from "./consts.ts";
import { InngestSpanProcessor } from "./processor.ts";

const debug = Debug(`${debugPrefix}:createProvider`);

export type Behaviour = "createProvider" | "extendProvider" | "off" | "auto";
export type Instrumentations = (Instrumentation | Instrumentation[])[];

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

    const p = new BasicTracerProvider({
      spanProcessors: [processor],
    });

    // Must be set before registerInstrumentations so they resolve this
    // provider, not the no-op default.
    trace.setGlobalTracerProvider(p);

    const instrList: Instrumentations = [...instrumentations];

    // Without a context manager, user-created spans have no parent and the
    // processor filters them out. AsyncLocalStorageContextManager works in
    // Node.js and in runtimes with AsyncLocalStorage (e.g. Workers with
    // nodejs_compat); AsyncHooksContextManager is deprecated and a no-op in
    // Workers since async_hooks.createHook is stubbed.
    try {
      const { AsyncLocalStorageContextManager } = await import(
        "@opentelemetry/context-async-hooks"
      );
      context.setGlobalContextManager(
        new AsyncLocalStorageContextManager().enable(),
      );
    } catch (err) {
      console.warn(
        "Inngest: failed to set up OTel context manager; user-created spans will not be associated with runs.",
        err,
      );
    }

    // Node-only; unavailable in Workers. Inngest span collection still works
    // without these — only third-party library auto-instrumentation is lost.
    try {
      const { getNodeAutoInstrumentations } = await import(
        "@opentelemetry/auto-instrumentations-node"
      );
      const { AnthropicInstrumentation } = await import(
        "@traceloop/instrumentation-anthropic"
      );

      instrList.push(
        ...getNodeAutoInstrumentations(),
        new AnthropicInstrumentation(),
      );
    } catch (err) {
      debug("Node.js auto-instrumentations unavailable, skipping:", err);
    }

    // Dynamic import: static imports caused version conflicts with host OTel
    // setups (e.g. Sentry) and silently broke inngest.send(). See #1324.
    const { registerInstrumentations } = await import(
      "@opentelemetry/instrumentation"
    );

    registerInstrumentations({
      instrumentations: instrList,
    });

    return { success: true, processor };
  } catch (err) {
    // Reset globals so a partial setup doesn't leak spans into an orphaned
    // processor with no client association.
    try {
      trace.disable();
      context.disable();
    } catch (cleanupErr) {
      debug("cleanup after failed provider setup also failed:", cleanupErr);
    }
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
