import type { Instrumentation } from "@opentelemetry/instrumentation";

const openAIInstrumentationName = "@opentelemetry/instrumentation-openai";

let instrumentationRegistration: Promise<void> | undefined;

export const registerAIMetadataInstrumentations = (): Promise<void> => {
  if (instrumentationRegistration) {
    return instrumentationRegistration;
  }

  instrumentationRegistration = registerAIMetadataInstrumentationsOnce();
  return instrumentationRegistration;
};

const registerAIMetadataInstrumentationsOnce = async (): Promise<void> => {
  const { registerInstrumentations } = await import(
    "@opentelemetry/instrumentation"
  );
  const { getNodeAutoInstrumentations } = await import(
    "@opentelemetry/auto-instrumentations-node"
  );
  const { AnthropicInstrumentation } = await import(
    "@traceloop/instrumentation-anthropic"
  );

  const instrumentations: Instrumentation[] = [
    ...getOpenAIInstrumentations(
      getNodeAutoInstrumentations({
        [openAIInstrumentationName]: {
          enabled: true,
        },
      }),
    ),
    new AnthropicInstrumentation(),
  ];

  registerInstrumentations({ instrumentations });
};

const getOpenAIInstrumentations = (
  instrumentations: Instrumentation[],
): Instrumentation[] => {
  return instrumentations.filter((instrumentation) => {
    return instrumentation.instrumentationName === openAIInstrumentationName;
  });
};

export const disableAIMetadataAutoInstrumentations = {
  [openAIInstrumentationName]: {
    enabled: false,
  },
} as const;
