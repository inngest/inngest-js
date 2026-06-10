import type { Instrumentation } from "@opentelemetry/instrumentation";

export type Instrumentations = (Instrumentation | Instrumentation[])[];

const openAIInstrumentationName = "@opentelemetry/instrumentation-openai";

let defaultInstrumentationsRegistration: Promise<void> | undefined;

export function registerDefaultInstrumentations(
  extra: Instrumentations = [],
): Promise<void> {
  const extraRegistration = registerExtraInstrumentations(extra);
  const defaultRegistration = ensureDefaultInstrumentationsRegistered();
  return Promise.all([extraRegistration, defaultRegistration]).then(() => {});
}

function ensureDefaultInstrumentationsRegistered(): Promise<void> {
  if (defaultInstrumentationsRegistration) {
    return defaultInstrumentationsRegistration;
  }

  defaultInstrumentationsRegistration =
    registerDefaultInstrumentationsOnce().catch((err) => {
      defaultInstrumentationsRegistration = undefined;
      throw err;
    });
  return defaultInstrumentationsRegistration;
}

async function registerExtraInstrumentations(
  extra: Instrumentations,
): Promise<void> {
  if (extra.length === 0) {
    return;
  }

  const { registerInstrumentations } = await import(
    "@opentelemetry/instrumentation"
  );

  registerInstrumentations({
    instrumentations: extra,
  });
}

async function registerDefaultInstrumentationsOnce(): Promise<void> {
  // Dynamic imports avoid pulling in the full auto-instrumentation suite at
  // module evaluation time. These are only needed when setting up OTel.
  const { getNodeAutoInstrumentations } = await import(
    "@opentelemetry/auto-instrumentations-node"
  );
  const { registerInstrumentations } = await import(
    "@opentelemetry/instrumentation"
  );
  const { AnthropicInstrumentation } = await import(
    "@traceloop/instrumentation-anthropic"
  );

  registerInstrumentations({
    instrumentations: [
      ...getNodeAutoInstrumentations({
        [openAIInstrumentationName]: {
          enabled: true,
        },
      }),
      new AnthropicInstrumentation(),
    ],
  });
}
