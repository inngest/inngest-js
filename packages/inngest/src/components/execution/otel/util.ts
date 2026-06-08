import { context, trace } from "@opentelemetry/api";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import {
  BasicTracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import { debugPrefix } from "./consts.ts";
import { disableAIMetadataAutoInstrumentations } from "./metadataProcessor/instrumentations.ts";
import { InngestSpanProcessor } from "./processor.ts";

const debug = Debug(`${debugPrefix}:createProvider`);

export type Behaviour = "createProvider" | "extendProvider" | "off" | "auto";
export type Instrumentations = (Instrumentation | Instrumentation[])[];

type ProviderResult = { success: true } | { success: false; error?: unknown };
type CreateProviderResult =
  | { success: true; processor: InngestSpanProcessor }
  | { success: false; error?: unknown };

let activeProviderCreation: Promise<ProviderResult> | undefined;

const getExistingProvider = () => {
  const globalProvider = trace.getTracerProvider();
  if (!globalProvider) {
    return undefined;
  }

  if (
    "getDelegate" in globalProvider &&
    typeof globalProvider.getDelegate === "function"
  ) {
    return globalProvider.getDelegate();
  }

  return globalProvider;
};

const registerAutoInstrumentations = async (
  extra: Instrumentations,
): Promise<void> => {
  // Dynamic imports avoid pulling in the full auto-instrumentation suite at
  // module evaluation time. These are only needed when creating a new
  // provider; static imports caused version conflicts with host app OTel
  // setups (e.g. Sentry) and silently broke inngest.send(). See #1324.
  const { getNodeAutoInstrumentations } = await import(
    "@opentelemetry/auto-instrumentations-node"
  );
  const { registerInstrumentations } = await import(
    "@opentelemetry/instrumentation"
  );

  registerInstrumentations({
    instrumentations: [
      ...extra,
      ...getNodeAutoInstrumentations(disableAIMetadataAutoInstrumentations),
    ],
  });
};

/**
 * Create a new `BasicTracerProvider` carrying `processor` and install it
 * as the global provider. If another caller registered a provider first,
 * extend theirs instead.
 */
const installNewGlobalProvider = async (
  processor: SpanProcessor,
): Promise<ProviderResult> => {
  const { AsyncHooksContextManager } = await import(
    "@opentelemetry/context-async-hooks"
  );

  const p = new BasicTracerProvider({ spanProcessors: [processor] });

  if (!trace.setGlobalTracerProvider(p)) {
    if (extendProviderWithProcessor(processor, "auto").success) {
      return { success: true };
    }
    return {
      success: false,
      error: new Error("Unable to set or extend global OTel provider"),
    };
  }

  context.setGlobalContextManager(new AsyncHooksContextManager().enable());
  return { success: true };
};

/**
 * Try to attach `processor` to a global OTel provider. Extends an existing
 * provider when possible; otherwise installs a new one. When
 * `trackInFlight` is true, publishes the in-flight promise so concurrent
 * `installProcessor` calls without `trackInFlight` can wait and land on
 * the same provider.
 */
const installProcessor = async (
  processor: SpanProcessor,
  opts: { instrumentations?: Instrumentations; trackInFlight?: boolean } = {},
): Promise<ProviderResult> => {
  const work = async (): Promise<ProviderResult> => {
    try {
      if (opts.instrumentations) {
        await registerAutoInstrumentations(opts.instrumentations);
      }

      if (extendProviderWithProcessor(processor, "auto").success) {
        return { success: true };
      }

      // Follower path: a concurrent initiator may be mid-creation. Wait for
      // it, then try to extend whatever it produced.
      if (!opts.trackInFlight && (await waitForActiveProviderCreation())) {
        if (extendProviderWithProcessor(processor, "auto").success) {
          return { success: true };
        }
      }

      return await installNewGlobalProvider(processor);
    } catch (err) {
      debug("failed to register processor:", err);
      return { success: false, error: err };
    }
  };

  if (!opts.trackInFlight) {
    return work();
  }

  const p = work();
  activeProviderCreation = p;
  return p.finally(() => {
    if (activeProviderCreation === p) {
      activeProviderCreation = undefined;
    }
  });
};

export const createProvider = async (
  instrumentations: Instrumentations = [],
): Promise<CreateProviderResult> => {
  const processor = new InngestSpanProcessor();
  const result = await installProcessor(processor, {
    instrumentations,
    trackInFlight: true,
  });
  return result.success ? { success: true, processor } : result;
};

export const createProviderWithProcessor = (
  processor: SpanProcessor,
): Promise<ProviderResult> => installProcessor(processor);

const waitForActiveProviderCreation = async (): Promise<boolean> => {
  await new Promise<void>((resolve) => {
    queueMicrotask(resolve);
  });

  const creation = activeProviderCreation;
  if (!creation) {
    return false;
  }

  await creation.catch(() => undefined);
  return true;
};

/**
 * Attempts to extend the existing OTel provider with an InngestSpanProcessor.
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
