import { context, trace } from "@opentelemetry/api";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import { attachToGlobalProvider } from "./attach.ts";
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

    trace.setGlobalTracerProvider(p);
    context.setGlobalContextManager(new AsyncHooksContextManager().enable());

    return { success: true, processor };
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

  if (attachToGlobalProvider(processor)) {
    return { success: true, processor };
  }

  if (behaviour !== "auto") {
    console.warn(
      "Unable to add InngestSpanProcessor to existing OTel provider. " +
        "Either no provider is registered, it is not a BasicTracerProvider, or it does not support addSpanProcessor() (OTel SDK v1) or expose _activeSpanProcessor._spanProcessors (OTel SDK v2). " +
        'Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.',
    );
  }

  return { success: false };
};
