import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, test } from "vitest";
import {
  AIMetadataExtractionReadinessReason,
  ExtendedTracesBehavior,
  ExtendedTracesReadinessReason,
  SendEventsReadinessReason,
} from "../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import { createClient } from "../test/helpers.ts";
import { extendedTracesMiddleware } from "./execution/otel/middleware.ts";
import {
  featureObservationsToJson,
  sdkFeatureObservations,
} from "./sdkFeatureObservations.ts";

async function sendEventsObservation(client: ReturnType<typeof createClient>) {
  const observation = (await sdkFeatureObservations.get(client)).find(
    (obs) => obs.sendEvents,
  );

  if (!observation?.sendEvents) {
    throw new Error("send events observation missing");
  }

  return observation.sendEvents;
}

async function aiMetadataExtractionObservation(
  client: ReturnType<typeof createClient>,
) {
  const observation = (await sdkFeatureObservations.get(client)).find(
    (obs) => obs.aiMetadataExtraction,
  );

  if (!observation?.aiMetadataExtraction) {
    throw new Error("AI metadata extraction observation missing");
  }

  return observation.aiMetadataExtraction;
}

async function extendedTracesObservation(
  client: ReturnType<typeof createClient>,
) {
  const observation = (await sdkFeatureObservations.get(client)).find(
    (obs) => obs.extendedTraces,
  );

  if (!observation?.extendedTraces) {
    throw new Error("extended traces observation missing");
  }

  return observation.extendedTraces;
}

describe("feature observations", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  test("reports missing event keys as ready in Dev mode", async () => {
    const client = createClient({ id: "test", isDev: true });

    await expect(sendEventsObservation(client)).resolves.toEqual({
      readinessReason:
        SendEventsReadinessReason.SEND_EVENTS_READINESS_REASON_READY,
      config: {
        hasEventKey: false,
        hasEventApiOriginOverride: false,
      },
    });
  });

  test("reports missing event keys as not ready in Cloud mode", async () => {
    const client = createClient({ id: "test", isDev: false });

    await expect(sendEventsObservation(client)).resolves.toEqual({
      readinessReason:
        SendEventsReadinessReason.SEND_EVENTS_READINESS_REASON_EVENT_KEY_MISSING,
      config: {
        hasEventKey: false,
        hasEventApiOriginOverride: false,
      },
    });
  });

  test("reports Event API origin override without parsing the URL", async () => {
    const client = createClient({
      id: "test",
      isDev: true,
      baseUrl: "whatever",
    });

    await expect(sendEventsObservation(client)).resolves.toMatchObject({
      config: {
        hasEventApiOriginOverride: true,
      },
    });
  });

  test("encodes observations with generated protobuf JSON", async () => {
    const client = createClient({ id: "test", isDev: true });
    const observation = (await sdkFeatureObservations.get(client)).find(
      (obs) => obs.sendEvents,
    );
    if (!observation) {
      throw new Error("send events observation missing");
    }

    expect(featureObservationsToJson([observation])[0]).toEqual({
      sendEvents: {
        readinessReason: "SEND_EVENTS_READINESS_REASON_READY",
        config: {},
      },
    });
  });

  test("encodes Extended Traces config as config", async () => {
    trace.setGlobalTracerProvider(new BasicTracerProvider());
    const client = createClient({
      id: "test",
      isDev: true,
      middleware: [extendedTracesMiddleware({ behaviour: "auto" })],
    });
    const observation = (await sdkFeatureObservations.get(client)).find(
      (obs) => obs.extendedTraces,
    );
    if (!observation) {
      throw new Error("extended traces observation missing");
    }

    expect(featureObservationsToJson([observation])[0]).toEqual({
      extendedTraces: {
        readinessReason: "EXTENDED_TRACES_READINESS_REASON_READY",
        config: {
          behavior: "EXTENDED_TRACES_BEHAVIOR_AUTO",
        },
        otelSetup: {
          path: "OTEL_SETUP_PATH_EXTEND_EXISTING_PROVIDER",
          providerFound: true,
          providerSource: "OTEL_PROVIDER_SOURCE_USER_PROVIDED",
          addSpanProcessorAttempted: true,
          spanProcessorAdded: true,
        },
      },
    });
  });

  test("reports explicitly disabled AI metadata extraction", async () => {
    const client = createClient({
      id: "test",
      isDev: true,
      aiMetadata: false,
    });

    expect(
      (await aiMetadataExtractionObservation(client)).readinessReason,
    ).toBe(
      AIMetadataExtractionReadinessReason.AI_METADATA_EXTRACTION_READINESS_REASON_DISABLED_BY_USER,
    );
  });

  test("reports Extended Traces as not enabled when middleware is absent", async () => {
    const client = createClient({ id: "test", isDev: true });

    await expect(extendedTracesObservation(client)).resolves.toEqual({
      readinessReason:
        ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_NOT_ENABLED_BY_USER,
      config: {
        behavior: ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_UNSPECIFIED,
      },
      otelSetup: undefined,
    });
  });

  test("reports explicitly disabled Extended Traces", async () => {
    const client = createClient({
      id: "test",
      isDev: true,
      middleware: [extendedTracesMiddleware({ behaviour: "off" })],
    });

    await expect(extendedTracesObservation(client)).resolves.toEqual({
      readinessReason:
        ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_DISABLED_BY_USER,
      config: {
        behavior: ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_OFF,
      },
      otelSetup: undefined,
    });
  });

  test("encodes first-party OTel provider source", async () => {
    const provider = new BasicTracerProvider();
    Object.defineProperty(provider, Symbol.for("inngest.otel.provider"), {
      value: true,
    });
    trace.setGlobalTracerProvider(provider);

    const client = createClient({
      id: "test",
      isDev: true,
      middleware: [extendedTracesMiddleware({ behaviour: "auto" })],
    });
    const observation = (await sdkFeatureObservations.get(client)).find(
      (obs) => obs.extendedTraces,
    );
    if (!observation) {
      throw new Error("extended traces observation missing");
    }

    expect(featureObservationsToJson([observation])[0]).toEqual({
      extendedTraces: {
        readinessReason: "EXTENDED_TRACES_READINESS_REASON_READY",
        config: {
          behavior: "EXTENDED_TRACES_BEHAVIOR_AUTO",
        },
        otelSetup: {
          path: "OTEL_SETUP_PATH_EXTEND_EXISTING_PROVIDER",
          providerFound: true,
          providerSource: "OTEL_PROVIDER_SOURCE_FIRST_PARTY",
          addSpanProcessorAttempted: true,
          spanProcessorAdded: true,
        },
      },
    });
  });
});
