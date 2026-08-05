import type { Mode } from "../helpers/env.ts";
import { isRecord } from "../helpers/types.ts";
import {
  AIMetadataExtractionReadinessReason,
  ExtendedTracesBehavior,
  ExtendedTracesReadinessReason,
  FeatureObservations,
  type OTelSetup,
  OTelSetupFailure,
  OTelSetupPath,
  SendEventsReadinessReason,
} from "../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import type { Behaviour } from "./execution/otel/util.ts";
import type { Inngest } from "./Inngest.ts";

export const featureObservationStateSymbol = Symbol.for(
  "inngest.featureObservationState",
);

export const featureObservationsSymbol = Symbol.for(
  "inngest.featureObservations",
);

export interface FeatureObservationState {
  aiMetadata: {
    enabled: boolean;
    setup?: OTelSetup;
  };
  extendedTraces?: {
    behavior: ExtendedTracesBehavior;
    setup?: OTelSetup;
  };
}

export type FeatureObservationsJson = Record<string, unknown>;

export function featureObservationsToJson(
  observations: FeatureObservations,
): FeatureObservationsJson {
  const json = FeatureObservations.toJSON(observations);
  if (!isRecord(json)) {
    throw new Error("SDK feature observations must serialize to a JSON object");
  }

  return json;
}

/**
 * Stateless helpers for reading and updating SDK feature observations.
 *
 * Observation data is stored on each Inngest client, not in this object, so
 * multiple clients in the same process remain isolated.
 */
class SdkFeatureObservations {
  readonly aiMetadata = {
    get: (client: Inngest.Any): FeatureObservationState["aiMetadata"] => {
      return client[featureObservationStateSymbol].aiMetadata;
    },

    replace: (
      client: Inngest.Any,
      observation: FeatureObservationState["aiMetadata"],
    ): void => {
      client[featureObservationStateSymbol].aiMetadata = observation;
    },

    replaceSetup: (client: Inngest.Any, setup: OTelSetup | undefined): void => {
      client[featureObservationStateSymbol].aiMetadata.setup = setup;
    },
  };

  readonly extendedTraces = {
    get: (client: Inngest.Any): FeatureObservationState["extendedTraces"] => {
      return client[featureObservationStateSymbol].extendedTraces;
    },

    replace: (
      client: Inngest.Any,
      observation: FeatureObservationState["extendedTraces"],
    ): void => {
      client[featureObservationStateSymbol].extendedTraces = observation;
    },
  };

  createState({
    aiMetadataEnabled,
  }: {
    aiMetadataEnabled: boolean;
  }): FeatureObservationState {
    return {
      aiMetadata: {
        enabled: aiMetadataEnabled,
      },
    };
  }

  get(client: Inngest.Any): FeatureObservations {
    return client[featureObservationsSymbol]();
  }

  getJson(client: Inngest.Any): FeatureObservationsJson {
    return featureObservationsToJson(this.get(client));
  }
}

export const sdkFeatureObservations = new SdkFeatureObservations();

export function behaviourToExtendedTracesBehavior(
  behaviour: Behaviour | string,
): ExtendedTracesBehavior {
  switch (behaviour) {
    case "extendProvider":
      return ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_EXTEND_PROVIDER;
    case "off":
      return ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_OFF;
    case "auto":
      return ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_AUTO;
    case "createProvider":
      return ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_CREATE_PROVIDER;
    default:
      return ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_UNKNOWN;
  }
}

export function collectFeatureObservations({
  state,
  mode,
  eventKeyConfigured,
  eventApiOriginOverrideConfigured,
}: {
  state: FeatureObservationState;
  mode: Mode;
  eventKeyConfigured: boolean;
  eventApiOriginOverrideConfigured: boolean;
}): FeatureObservations {
  return {
    aiMetadataExtraction: aiMetadataObservation(state.aiMetadata),
    extendedTraces: extendedTracesObservation(state.extendedTraces),
    sendEvents: sendEventsObservation({
      mode,
      eventKeyConfigured,
      eventApiOriginOverrideConfigured,
    }),
  };
}

function aiMetadataObservation({
  enabled,
  setup,
}: FeatureObservationState["aiMetadata"]): FeatureObservations["aiMetadataExtraction"] {
  if (!enabled) {
    return {
      readinessReason:
        AIMetadataExtractionReadinessReason.AI_METADATA_EXTRACTION_READINESS_REASON_DISABLED_BY_USER,
      otelSetup: undefined,
    };
  }

  return {
    readinessReason: aiMetadataReadinessReason(setup),
    otelSetup: setup,
  };
}

function aiMetadataReadinessReason(
  setup: OTelSetup | undefined,
): AIMetadataExtractionReadinessReason {
  if (!setup?.providerFound) {
    return AIMetadataExtractionReadinessReason.AI_METADATA_EXTRACTION_READINESS_REASON_OTEL_PROVIDER_MISSING;
  }

  if (setup.spanProcessorAdded) {
    return AIMetadataExtractionReadinessReason.AI_METADATA_EXTRACTION_READINESS_REASON_READY;
  }

  return AIMetadataExtractionReadinessReason.AI_METADATA_EXTRACTION_READINESS_REASON_OTEL_SPAN_PROCESSOR_NOT_ADDED;
}

function extendedTracesObservation(
  state: FeatureObservationState["extendedTraces"],
): FeatureObservations["extendedTraces"] {
  if (!state) {
    return {
      readinessReason:
        ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_NOT_ENABLED_BY_USER,
      config: {
        behavior: ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_UNSPECIFIED,
      },
      otelSetup: undefined,
    };
  }

  return {
    readinessReason: extendedTracesReadinessReason(state),
    config: {
      behavior: state.behavior,
    },
    otelSetup: state.setup,
  };
}

function extendedTracesReadinessReason({
  behavior,
  setup,
}: NonNullable<
  FeatureObservationState["extendedTraces"]
>): ExtendedTracesReadinessReason {
  if (
    behavior === ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_OFF ||
    behavior === ExtendedTracesBehavior.EXTENDED_TRACES_BEHAVIOR_UNKNOWN
  ) {
    return ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_DISABLED_BY_USER;
  }

  if (setup?.spanProcessorAdded) {
    return ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_READY;
  }

  if (setup?.path === OTelSetupPath.OTEL_SETUP_PATH_LEGACY_CREATE_PROVIDER) {
    return ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_OTEL_PROVIDER_CREATION_FAILED;
  }

  if (setup?.failure === OTelSetupFailure.OTEL_SETUP_FAILURE_NO_PROVIDER) {
    return ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_OTEL_PROVIDER_MISSING;
  }

  return ExtendedTracesReadinessReason.EXTENDED_TRACES_READINESS_REASON_OTEL_SPAN_PROCESSOR_NOT_ADDED;
}

function sendEventsObservation({
  mode,
  eventKeyConfigured,
  eventApiOriginOverrideConfigured,
}: {
  mode: Mode;
  eventKeyConfigured: boolean;
  eventApiOriginOverrideConfigured: boolean;
}): FeatureObservations["sendEvents"] {
  let readinessReason =
    SendEventsReadinessReason.SEND_EVENTS_READINESS_REASON_EVENT_KEY_MISSING;

  // Dev mode doesn't need an event key.
  if (mode === "dev" || eventKeyConfigured) {
    readinessReason =
      SendEventsReadinessReason.SEND_EVENTS_READINESS_REASON_READY;
  }

  return {
    readinessReason,
    config: {
      eventKeyConfigured,
      eventApiOriginOverrideConfigured,
    },
  };
}
