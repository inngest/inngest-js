import { context, trace } from "@opentelemetry/api";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import {
  type Instrumentation,
  registerInstrumentations,
} from "@opentelemetry/instrumentation";
import {
  BasicTracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import Debug from "debug";
import { debugPrefix } from "./consts.ts";
import { aiMetadataSpanProcessor } from "./metadataProcessor/processor.ts";

const debug = Debug(`${debugPrefix}:instrumentTraces`);

type ProviderResult = { success: true } | { success: false; error?: unknown };
type Instrumentations = (Instrumentation | Instrumentation[])[];

let isTraceInstrumentationStarted = false;

/**
 * Installs Inngest trace instrumentation into the process-global OTel provider.
 * Call this before importing instrumented libraries.
 */
export function instrumentTraces(): void {
  if (isTraceInstrumentationStarted) {
    return;
  }

  isTraceInstrumentationStarted = true;

  const instrumented = registerTraceInstrumentations();
  if (!instrumented.success) {
    isTraceInstrumentationStarted = false;
    debug("unable to register trace instrumentations", instrumented.error);
    return;
  }

  const registered = setupTraceProvider(aiMetadataSpanProcessor);
  if (!registered.success) {
    isTraceInstrumentationStarted = false;
    debug("unable to create provider", registered.error);
  }
}

function registerTraceInstrumentations(): ProviderResult {
  try {
    // Keep this list intentionally aligned with Extended Traces.
    const instrumentations: Instrumentations = [
      ...getNodeAutoInstrumentations(),
      new AnthropicInstrumentation(),
    ];

    registerInstrumentations({
      instrumentations,
    });

    return { success: true };
  } catch (err) {
    debug("failed to register trace instrumentations:", err);
    return { success: false, error: err };
  }
}

function setupTraceProvider(processor: SpanProcessor): ProviderResult {
  const extended = extendProvider(processor);
  if (extended.success) {
    return extended;
  }

  return createProvider(processor);
}

function extendProvider(
  processor: SpanProcessor,
): { success: true } | { success: false } {
  const existingProvider = getExistingProvider();
  if (!existingProvider) {
    return { success: false };
  }

  if (hasAddSpanProcessor(existingProvider)) {
    existingProvider.addSpanProcessor(processor);
    return { success: true };
  }

  const spanProcessors = getInternalSpanProcessors(existingProvider);
  if (spanProcessors) {
    spanProcessors.push(processor);
    return { success: true };
  }

  return { success: false };
}

function createProvider(processor: SpanProcessor): ProviderResult {
  try {
    const provider = new BasicTracerProvider({
      spanProcessors: [processor],
    });

    if (!trace.setGlobalTracerProvider(provider)) {
      return extendProvider(processor);
    }

    context.setGlobalContextManager(new AsyncHooksContextManager().enable());
    return { success: true };
  } catch (err) {
    debug("failed to create provider:", err);
    return { success: false, error: err };
  }
}

function getExistingProvider(): unknown {
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
}

function hasAddSpanProcessor(
  provider: unknown,
): provider is { addSpanProcessor(processor: SpanProcessor): void } {
  if (typeof provider !== "object" || provider === null) {
    return false;
  }

  if (!("addSpanProcessor" in provider)) {
    return false;
  }

  return typeof provider.addSpanProcessor === "function";
}

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

    const spanProcessors = active._spanProcessors;
    if (!Array.isArray(spanProcessors)) {
      return undefined;
    }

    return spanProcessors;
  } catch {
    return undefined;
  }
}
