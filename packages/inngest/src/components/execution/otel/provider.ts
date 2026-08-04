import { trace } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { isRecord } from "../../../helpers/types.ts";
import {
  OTelProviderSource,
  OTelSetup,
  OTelSetupFailure,
  type OTelSetup as OTelSetupMessage,
  OTelSetupPath,
} from "../../../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";

export const providerMarker = Symbol.for("inngest.otel.provider");

/**
 * Build a complete OTel setup observation while keeping call sites focused on
 * only the fields they learned during a provider setup attempt.
 */
function setupWith(
  setup: Readonly<Partial<OTelSetupMessage> & Pick<OTelSetupMessage, "path">>,
): OTelSetupMessage {
  return OTelSetup.fromPartial(setup);
}

function isNoopTracerProvider(provider: unknown): boolean {
  if (!isRecord(provider)) {
    return false;
  }

  // OpenTelemetry returns a no-op provider when no real provider has been
  // registered. It has no useful public marker, so identify it by constructor.
  if (!provider.constructor) {
    return false;
  }

  return provider.constructor.name === "NoopTracerProvider";
}

/**
 * Resolve the currently-registered global OTel tracer provider, unwrapping
 * OpenTelemetry's ProxyTracerProvider. Returns undefined when only the default
 * no-op provider is available.
 */
export function getGlobalProvider(): object | undefined {
  const globalProvider = trace.getTracerProvider();
  if (!globalProvider) {
    return undefined;
  }

  let existingProvider = globalProvider;
  if (
    "getDelegate" in globalProvider &&
    typeof globalProvider.getDelegate === "function"
  ) {
    existingProvider = globalProvider.getDelegate();
  }

  if (!existingProvider || isNoopTracerProvider(existingProvider)) {
    return undefined;
  }

  return existingProvider;
}

/**
 * Detect providers created by Inngest first-party instrumentation (i.e.
 * @inngest/otel).
 */
export function isFirstPartyProvider(provider: object): boolean {
  return (provider as Record<symbol, unknown>)[providerMarker] === true;
}

function getProviderSource(provider: object): OTelProviderSource {
  if (isFirstPartyProvider(provider)) {
    return OTelProviderSource.OTEL_PROVIDER_SOURCE_FIRST_PARTY;
  }

  return OTelProviderSource.OTEL_PROVIDER_SOURCE_USER_PROVIDED;
}

/**
 * Attempts to add the given span processor to the given OTel provider.
 * Handles OTel SDK v1's public addSpanProcessor() API and OTel SDK v2's
 * current internal MultiSpanProcessor shape.
 */
export function attachToProvider(
  provider: object,
  processor: SpanProcessor,
): boolean {
  if (
    "addSpanProcessor" in provider &&
    typeof (provider as { addSpanProcessor?: unknown }).addSpanProcessor ===
      "function"
  ) {
    (
      provider as unknown as {
        addSpanProcessor: (p: SpanProcessor) => void;
      }
    ).addSpanProcessor(processor);
    return true;
  }

  const spanProcessors = getInternalSpanProcessors(provider);
  if (spanProcessors) {
    spanProcessors.push(processor);
    return true;
  }

  return false;
}

export function attemptProviderExtension({
  path = OTelSetupPath.OTEL_SETUP_PATH_EXTEND_EXISTING_PROVIDER,
  processor,
}: {
  path?: OTelSetupPath;
  processor: SpanProcessor;
}): OTelSetupMessage {
  const provider = getGlobalProvider();
  if (!provider) {
    return setupWith({
      path,
      failure: OTelSetupFailure.OTEL_SETUP_FAILURE_NO_PROVIDER,
    });
  }

  const base = {
    path,
    providerFound: true,
    providerSource: getProviderSource(provider),
    addSpanProcessorAttempted: true,
  };

  try {
    if (attachToProvider(provider, processor)) {
      return setupWith({ ...base, spanProcessorAdded: true });
    }

    return setupWith({
      ...base,
      failure: OTelSetupFailure.OTEL_SETUP_FAILURE_NOT_ADDED,
    });
  } catch {
    return setupWith({
      ...base,
      failure: OTelSetupFailure.OTEL_SETUP_FAILURE_UNKNOWN_ERROR,
    });
  }
}

/**
 * Extract the internal span processors array from a BasicTracerProvider.
 * Returns the mutable array if accessible, undefined otherwise.
 *
 * Wrapped in try/catch because this accesses internal OTel fields that may
 * change; it must never crash the host app.
 */
function getInternalSpanProcessors(provider: unknown): unknown[] | undefined {
  if (!isRecord(provider)) {
    return undefined;
  }

  try {
    const active = provider._activeSpanProcessor;
    if (!isRecord(active)) return undefined;

    const arr = active._spanProcessors;
    if (!Array.isArray(arr)) {
      return undefined;
    }

    return arr;
  } catch {
    return undefined;
  }
}
