import { context, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import { debugPrefix } from "../consts.ts";
import { withOTelLock } from "../providerSetupMutex.ts";
import type { Instrumentations } from "../util.ts";

const debug = Debug(`${debugPrefix}:AIMetadataProvider`);

type ProviderResult = { success: true } | { success: false; error?: unknown };

export async function registerAIMetadataProvider(
  processor: SpanProcessor,
): Promise<ProviderResult> {
  return withOTelLock(function () {
    return registerAIMetadataProviderLocked(processor);
  });
}

async function registerAIMetadataProviderLocked(
  processor: SpanProcessor,
): Promise<ProviderResult> {
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

async function createProvider(
  processor: SpanProcessor,
): Promise<ProviderResult> {
  try {
    const provider = new BasicTracerProvider({
      spanProcessors: [processor],
    });

    // Keep this list intentionally aligned with Extended Traces.
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

    const instrumentations: Instrumentations = [
      ...getNodeAutoInstrumentations(),
      new AnthropicInstrumentation(),
    ];

    registerInstrumentations({
      instrumentations,
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
