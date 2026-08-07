import { context, trace } from "@opentelemetry/api";
import type { Instrumentation } from "@opentelemetry/instrumentation";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import {
  OTelProviderSource,
  type OTelSetup,
  OTelSetupFailure,
  OTelSetupPath,
} from "../../../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import { debugPrefix } from "./consts.ts";
import { InngestSpanProcessor } from "./processor.ts";
import { attemptProviderExtension } from "./provider.ts";

const debug = Debug(`${debugPrefix}:createProvider`);

export type Behaviour = "createProvider" | "extendProvider" | "off" | "auto";
export type Instrumentations = (Instrumentation | Instrumentation[])[];

export const createProvider = async (
  _behaviour: Behaviour,
  instrumentations: Instrumentations | undefined = [],
): Promise<
  | { success: true; processor: InngestSpanProcessor; setup: OTelSetup }
  | { success: false; error?: unknown; setup: OTelSetup }
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

    if (!trace.setGlobalTracerProvider(p)) {
      return {
        success: false,
        setup: {
          path: OTelSetupPath.OTEL_SETUP_PATH_LEGACY_CREATE_PROVIDER,
          providerFound: false,
          providerSource: OTelProviderSource.OTEL_PROVIDER_SOURCE_LEGACY_SDK,
          addSpanProcessorAttempted: true,
          spanProcessorAdded: false,
          failure: OTelSetupFailure.OTEL_SETUP_FAILURE_PROVIDER_CREATION_FAILED,
        },
      };
    }

    context.setGlobalContextManager(new AsyncHooksContextManager().enable());

    return {
      success: true,
      processor,
      setup: {
        path: OTelSetupPath.OTEL_SETUP_PATH_LEGACY_CREATE_PROVIDER,
        providerFound: false,
        providerSource: OTelProviderSource.OTEL_PROVIDER_SOURCE_LEGACY_SDK,
        addSpanProcessorAttempted: true,
        spanProcessorAdded: true,
        failure: OTelSetupFailure.OTEL_SETUP_FAILURE_UNSPECIFIED,
      },
    };
  } catch (err) {
    debug("failed to create provider:", err);
    return {
      success: false,
      error: err,
      setup: {
        path: OTelSetupPath.OTEL_SETUP_PATH_LEGACY_CREATE_PROVIDER,
        providerFound: false,
        providerSource: OTelProviderSource.OTEL_PROVIDER_SOURCE_LEGACY_SDK,
        addSpanProcessorAttempted: true,
        spanProcessorAdded: false,
        failure: OTelSetupFailure.OTEL_SETUP_FAILURE_PROVIDER_CREATION_FAILED,
      },
    };
  }
};

export function warnDeprecatedCreateProviderBehaviour(
  behaviour: Extract<Behaviour, "auto" | "createProvider">,
): void {
  if (behaviour === "auto") {
    console.warn(
      "`extendedTracesMiddleware()` falling back to creating an OpenTelemetry provider is deprecated. Use @inngest/otel instead.",
    );
    return;
  }

  console.warn(
    '`extendedTracesMiddleware({ behaviour: "createProvider" })` is deprecated. Use @inngest/otel instead.',
  );
}

/**
 * Attempts to extend the existing OTel provider with our processor. Returns true
 * if the provider was extended, false if it was not.
 */
export const extendProvider = (
  behaviour: Behaviour,
):
  | { success: true; processor: InngestSpanProcessor; setup: OTelSetup }
  | { success: false; setup: OTelSetup } => {
  const processor = new InngestSpanProcessor();
  const setup = attemptProviderExtension({ processor });

  if (!setup.providerFound) {
    if (behaviour !== "auto") {
      console.warn(
        [
          "Inngest extended traces are disabled: no OpenTelemetry provider was registered before the middleware initialized.",
          "To fix, install @inngest/otel and load it before any app code:",
          "  npm install @inngest/otel",
          "  node --import @inngest/otel/node ./app.js",
          'If a framework CLI owns the node process (Next.js, Vite, etc.), set NODE_OPTIONS="--import @inngest/otel/node" or add `import "@inngest/otel/node"` as the first import of your entrypoint.',
          'Alternatively, register your own OpenTelemetry provider before creating the Inngest client, or silence this by disabling extended traces (behaviour "off", or `traces: false` for aiMiddleware).',
          "Docs: https://www.inngest.com/docs/examples/open-telemetry",
        ].join("\n"),
      );
    }

    return { success: false, setup };
  }

  if (setup.spanProcessorAdded) {
    return { success: true, processor, setup };
  }

  if (behaviour !== "auto") {
    console.warn(
      "Unable to add InngestSpanProcessor to existing OTel provider. " +
        "The provider does not support addSpanProcessor() (OTel SDK v1) " +
        "or expose _activeSpanProcessor._spanProcessors (OTel SDK v2). " +
        "Docs: https://www.inngest.com/docs/examples/open-telemetry",
    );
  }

  return { success: false, setup };
};
