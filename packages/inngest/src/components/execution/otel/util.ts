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
  const existingProvider = trace.getTracerProvider();
  if (!existingProvider) {
    if (behaviour !== "auto") {
      console.warn(
        'No existing OTel provider found and behaviour is "extendProvider". Inngest\'s OTel middleware will not work. Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.',
      );
    }

    return { success: false };
  }

  if (
    !("addSpanProcessor" in existingProvider) ||
    typeof existingProvider.addSpanProcessor !== "function"
  ) {
    // TODO Could we also add a function the user can provide that takes the
    // processor and adds it? That way they could support many different
    // providers.
    if (behaviour !== "auto") {
      console.warn(
        "Existing OTel provider is not a BasicTracerProvider. Inngest's OTel middleware will not work, as it can only extend an existing processor if it's a BasicTracerProvider.",
      );
    }

    return { success: false };
  }

  const processor = new InngestSpanProcessor();
  existingProvider.addSpanProcessor(processor);

  return { success: true, processor };
};
