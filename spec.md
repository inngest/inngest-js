# Problem

We don't have a good, consistent way of answering the following questions for SDK features:

- Did the user enable/disable it?
- When did the user enable/disable it?
- How is it configured?
- If it is not ready, what should the user change in their app to make it ready?

Answering these questions is important for multiple reasons:

- Product wants to measure feature adoption/abandonment.
- Product wants to know which users to schedule interviews with for beta features.
- Product wants to add feature nudges into the UI.
- Growth wants to quantify the user journey. For example, "how long do new users take before enabling feature X?"
- Support and engineering want to verify whether optional SDK features are wired correctly without inferring state from logs or user code. This includes historical info, like “was the feature enabled when this support ticket was created”.

While these are general problems, this spec is focused on observability for 2 specific features:

- AI Metadata Extraction (AIME)
- Extended Traces (ExT)

# Solution

Add a way for SDKs to report their feature observations (readiness and configuration) to the Inngest server during app sync. We'll only add this to the TypeScript SDK for now, but will eventually expand to the Python and Go SDKs.

The first supported observations are:

- AI Metadata Extraction (AIME)
- Extended Traces (ExT)
- Sending events, meaning `client.send()` and `step.sendEvent()`

Feature observations are machine-readable state, not user-facing copy. SDKs and the server should send enum values and structured setup facts. The UI owns labels, tooltip copy, and docs links so copy can differ by surface and can distinguish product semantics like "Disabled in app" versus "Not enabled in app."

Store the latest reported observations with the app. This will answer feature questions for the latest app sync and enable UI nudges.

Send internal analytics events when feature observations change. This will answer user journey questions.For example, "how long after signup do users take before enabling AIME?"

Display AIME and ExT readiness in the app UI. This should be a light nudge: AIME and ExT are optional, so unreadiness should communicate "there is app setup available if you want this feature" rather than "your app is broken."

Use protobuf for runtime type safety. We'll have to copy the same proto file between the server and SDK, since we don't have a solution for shared proto files yet. The proto package is scoped to SDK feature observations so it is not mistaken for a generic Dev Server or product feature model.

# Out of scope

Anything lower than app-level (e.g. function-level feature observations). For example, there isn't a plan for handling "checkpointing is enabled at the function level but disabled at the function-level".

Python and Go SDK implementations.

Reporting feature observations at execution time or during introspection.

Centralized proto files. This spec is the source of truth for the proto contract; implementation will copy the resulting proto into the SDK and Inngest server.

General SDK environment discovery, package detection, or third-party library reporting. This spec intentionally observes Inngest-owned feature readiness/configuration only.

# Context

AIME:

- Default-on and can be disabled with `aiMetadata: false`.
- Tries to add a metadata span processor to the existing global OpenTelemetry provider when the `Inngest` client is constructed.
- Does not make sense for every Inngest user. Non-AI users should not interpret AIME unreadiness as a problem.

ExT:

- Configured through `extendedTracesMiddleware()`.
- Is opt-in. If the middleware is absent, the correct state is "not enabled" rather than "disabled". It may be opt-out in the future.
- Has legacy `auto` and `createProvider` behavior, but provider creation is deprecated.

Sending events:

- Depends on having an event key in Cloud mode.
- Is ready in Dev mode even without an event key.
- Event API origin may be overridden, which is useful context but not a readiness blocker.

# Implementation

## Naming

Use "SDK feature observations" for the contract/module naming, not just "feature observations," because the server and UI have many other features that are unrelated to SDK-reported readiness.

## Transport

The SDK reports feature observations on registration bodies and Connect sync.

The SDK should add an optional `feature_observations` field to `InBandRegisterRequest` and the out-of-band registration request body. The field is omitted when the SDK cannot compute observations or when talking to paths that do not yet support this payload.

For JSON registration bodies, `feature_observations` is a JSON array of `FeatureObservation` messages encoded with protobuf JSON field names. It is not binary protobuf bytes and is not base64-encoded. The top-level field uses the existing registration body `snake_case` style; each observation uses protobuf JSON field names (`lowerCamelCase`).

JSON enum values must be encoded as numbers, not strings. Reasoning:

- Lets us change enum names to include "legacy" when we deprecate them.
- Keeps UI/server mapping logic tied to stable numeric values rather than generated enum names.
- Protobuf enum names are often long (due to shared prefixes).

Unknown enum numbers should be handled defensively by UI/server code.

Example JSON shape:

```json
{
  "feature_observations": [
    {
      "aiMetadataExtraction": {
        "readinessReason": 1,
        "otelSetup": {
          "path": 1,
          "providerFound": true,
          "providerSource": 1,
          "addSpanProcessorAttempted": true,
          "spanProcessorAdded": true
        }
      }
    },
    {
      "extendedTraces": {
        "readinessReason": 2,
        "config": {
          "behavior": 0
        }
      }
    },
    {
      "sendEvents": {
        "readinessReason": 1,
        "config": {}
      }
    }
  ]
}
```

The SDK should also add feature observations to the Connect sync payload for each app by adding `repeated sdk_feature_observations.v1.FeatureObservation feature_observations = 5;` to `AppConfiguration`.

When `feature_observations` is absent, the server must treat the app sync as "SDK did not report observations" and must not infer that features are disabled or not ready.

## Server handling

The server should parse feature observations with generated protobuf types on both transports:

- App sync JSON uses custom JSON handling that accepts protobuf JSON with lower-camel field names and numeric enum values.
- Connect uses the binary protobuf `AppConfiguration.feature_observations` field.

Feature observations are operational readiness metadata. They must not affect function versioning or the registration checksum. This lets observations refresh without forcing function resyncs or creating new app versions.

Sync deduplication must not skip observation persistence. The registration checksum answers "did function/app configuration change?" and should exclude `FeatureObservations`. A matching checksum may mark the deploy as duplicate and skip function synchronization, but it must not skip updating the app's latest SDK feature observations.

If the app sync failed then we still update the feature observations.

This applies to both Serve and Connect. For example, a Connect worker may reconnect with byte-for-byte identical function definitions but different AIME/ExT readiness after the user changes local OTel setup. That reconnect should update app metadata/UI state without requiring a function definition change.

## Storage

The server stores the latest reported observations with the app, preserving protobuf JSON mapping so each observation can be deserialized with generated protobuf structs.

For the Dev Server implementation, storing the JSON in app metadata is acceptable for the first wiring pass. For the Cloud implementation, store the latest observations in Postgres, likely on the `apps` table as `jsonb`.

## UI

The UI should display AIME and ExT readiness as app metadata alongside fields like SDK version, language, framework, and connected workers.

The UI should show:

- A green dot and "Ready" when readiness reason is `1`.
- A gray dot and a reason label when not ready.
- A tooltip next to the feature label that explains what the feature is and links to docs.

The UI owns user-facing copy. The server should not send labels like "Disabled in app" or "Not enabled in app"; it should only send the machine-readable readiness enum.

Initial labels:

| Feature | Reason number | Label |
| --- | --- | --- |
| AIME | 1 | Ready |
| AIME | 2 | Disabled in app |
| AIME | 3 | OTel provider missing |
| AIME | 4 | OTel span processor not added |
| ExT | 1 | Ready |
| ExT | 2 | Not enabled in app |
| ExT | 3 | Disabled in app |
| ExT | 4 | OTel provider missing |
| ExT | 5 | OTel span processor not added |
| ExT | 6 | OTel provider creation failed |

The AIME tooltip should avoid implying non-AI users have a broken app. It should communicate that AI OTel improves the debugging experience for AI product apps.

## Analytics

Before updating stored feature observations, the server compares the previous and next observation sets by parsed feature kind, not by raw JSON array equality. Observation order is not meaningful.

The Inngest server emits one analytics event for each changed feature observation. For change detection, the server checks whether anything changed in the feature observation object. Each event includes the feature kind, previous feature observation object, and next feature observation object. The server should derive the feature kind with a helper that maps the populated `FeatureObservation.feature` `oneof` to its canonical proto field name. These events must not be exposed in user-facing audit trails.

Follow this guide for analytics: **Analytics Instrumentation Guide**

Helper sketches:

```go
func featureObservationKind(obs *sdkfeatureobs.FeatureObservation) string {
	switch obs.GetFeature().(type) {
	case *sdkfeatureobs.FeatureObservation_AiMetadataExtraction:
		return "ai_metadata_extraction"
	case *sdkfeatureobs.FeatureObservation_ExtendedTraces:
		return "extended_traces"
	case *sdkfeatureobs.FeatureObservation_SendEvents:
		return "send_events"
	default:
		return "unknown"
	}
}

func featureObservationProtoJSON(obs *sdkfeatureobs.FeatureObservation) map[string]any {
	b, err := protojson.MarshalOptions{
		UseProtoNames:   false,
		UseEnumNumbers: true,
	}.Marshal(obs)
	if err != nil {
		return nil
	}

	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		return nil
	}

	return out
}
```

## Shared types

Use the protobuf definitions in this section as the source contract. The SDK should send feature observations as a repeated list during app sync. Each `FeatureObservation` reports exactly one feature with a typed `oneof`.

```protobuf
syntax = "proto3";
package sdk_feature_observations.v1;

option go_package = "github.com/inngest/inngest/proto/gen/sdk_feature_observations/v1;sdkfeatureobs";

message FeatureObservation {
  oneof feature {
    AIMetadataExtraction ai_metadata_extraction = 1;
    ExtendedTraces extended_traces = 2;
    SendEvents send_events = 3;
  }
}
```

AIME and ExT both depend on OpenTelemetry setup, so they share a setup message:

```protobuf
message OTelSetup {
  // Which setup path the SDK used or attempted.
  OTelSetupPath path = 1;

  // Whether the SDK found a global OpenTelemetry provider to extend.
  bool provider_found = 2;

  // Where the provider came from.
  OTelProviderSource provider_source = 3;

  // Whether the SDK attempted to add its span processor to the provider. This
  // is usually false when provider_found is false.
  bool add_span_processor_attempted = 4;

  // Whether the SDK successfully added its span processor to the provider.
  bool span_processor_added = 5;

  // Why OTel setup did not complete. Leave unspecified when setup succeeded.
  OTelSetupFailure failure = 6;
}

enum OTelProviderSource {
  // The SDK did not report provider source.
  OTEL_PROVIDER_SOURCE_UNSPECIFIED = 0;

  // The provider was created by a first-party Inngest OTel integration for
  // this SDK language.
  OTEL_PROVIDER_SOURCE_FIRST_PARTY = 1;

  // The provider existed before Inngest setup and was provided by user/app code
  // or another dependency.
  OTEL_PROVIDER_SOURCE_USER_PROVIDED = 2;

  // The provider was created through the SDK's deprecated legacy provider
  // creation path.
  OTEL_PROVIDER_SOURCE_LEGACY_SDK = 3;
}

enum OTelSetupPath {
  // The SDK did not report a specific OTel setup path.
  OTEL_SETUP_PATH_UNSPECIFIED = 0;

  // The SDK attempted to extend an existing global OpenTelemetry provider.
  OTEL_SETUP_PATH_EXTEND_EXISTING_PROVIDER = 1;

  // The SDK attempted the deprecated provider creation path.
  OTEL_SETUP_PATH_LEGACY_CREATE_PROVIDER = 2;
}

enum OTelSetupFailure {
  // The SDK did not report a specific OTel setup failure.
  OTEL_SETUP_FAILURE_UNSPECIFIED = 0;

  // The SDK could not find a global OpenTelemetry provider to extend.
  OTEL_SETUP_FAILURE_NO_PROVIDER = 1;

  // The SDK found a global OpenTelemetry provider, but did not add its span
  // processor.
  OTEL_SETUP_FAILURE_NOT_ADDED = 2;

  // The SDK tried to create a legacy OpenTelemetry provider, but provider
  // creation failed.
  OTEL_SETUP_FAILURE_PROVIDER_CREATION_FAILED = 3;

  // The SDK hit an unexpected error while adding its span processor.
  OTEL_SETUP_FAILURE_UNKNOWN_ERROR = 4;
}
```

The SDK should compute this setup state from the same code path that extends or creates the provider. This avoids the UI depending on warnings, logs, or inferred behavior. AIME always uses `OTEL_SETUP_PATH_EXTEND_EXISTING_PROVIDER`. ExT uses `OTEL_SETUP_PATH_EXTEND_EXISTING_PROVIDER` when it extends a provider and `OTEL_SETUP_PATH_LEGACY_CREATE_PROVIDER` when `behavior: "auto"` falls back to provider creation or `behavior: "createProvider"` is used.

## First-party OTel provider marker

The first-party OTel package for each SDK language (currently TS SDK has the only one) must mark providers that it creates so SDKs can reliably report `otel_setup.provider_source = OTEL_PROVIDER_SOURCE_FIRST_PARTY`.

For the TypeScript SDK, `@inngest/otel` creates a normal OpenTelemetry `BasicTracerProvider`, so the runtime object identifies as an OpenTelemetry provider, not as an Inngest-owned provider. File path inference is also not portable across ESM/CJS, bundlers, duplicate OpenTelemetry installs, and edge runtimes.

When `@inngest/otel` creates and successfully registers a provider, it should set a non-enumerable marker using a global symbol:

```tsx
export const providerMarker = Symbol.for("inngest.otel.provider");

Object.defineProperty(provider, providerMarker, {
  value: true,
  enumerable: false,
});
```

The SDK should use the same `Symbol.for("inngest.otel.provider")` key after unwrapping the global OTel provider. `provider_source` should be `FIRST_PARTY` only when this marker is present on the actual provider object. If `@inngest/otel` finds an existing provider and leaves it in place, it must not mark that provider as first-party.

Do not name this state after `@inngest/otel` in the proto. Python and Go may use different package names; the cross-SDK concept is first-party provider source.

## Connect proto

Connect app configuration should include SDK feature observations:

```protobuf
import "sdk_feature_observations/v1/feature_observations.proto";

message AppConfiguration {
  string app_name = 1;
  optional string app_version = 2;
  bytes functions = 4;
  repeated sdk_feature_observations.v1.FeatureObservation feature_observations = 5;
}
```

The TypeScript SDK's source proto import path can differ because its proto files live under `src/components`, but the package/type name must remain `sdk_feature_observations.v1.FeatureObservation`.

## AI Metadata Extraction

Answers:

- Is AIME ready?
- Did the user disable AIME with `aiMetadata: false`?
- OTel:
    - Is there a provider?
    - Was the provider first-party, user-provided, or legacy SDK-created?
    - Did we attempt to add the AIME span processor?
    - Does the provider support the SDK's span processor attachment path?

```protobuf
message AIMetadataExtraction {
  // Why AIME is or is not ready in this app.
  AIMetadataExtractionReadinessReason readiness_reason = 1;

  // How the SDK attempted to add the AIME metadata span processor to the global
  // OpenTelemetry provider.
  OTelSetup otel_setup = 2;
}

enum AIMetadataExtractionReadinessReason {
  // The SDK did not report a specific readiness reason.
  AI_METADATA_EXTRACTION_READINESS_REASON_UNSPECIFIED = 0;

  // AIME is enabled and the SDK added its metadata span processor to the global
  // OpenTelemetry provider.
  AI_METADATA_EXTRACTION_READINESS_REASON_READY = 1;

  // AIME is default-on, but the user explicitly opted out with
  // `aiMetadata: false`.
  AI_METADATA_EXTRACTION_READINESS_REASON_DISABLED_BY_USER = 2;

  // AIME is enabled, but no global OTel provider was available for the SDK to
  // extend.
  AI_METADATA_EXTRACTION_READINESS_REASON_OTEL_PROVIDER_MISSING = 3;

  // The SDK found an OTel provider, but did not add its metadata span
  // processor.
  AI_METADATA_EXTRACTION_READINESS_REASON_OTEL_SPAN_PROCESSOR_NOT_ADDED = 4;
}
```

Readiness mapping:

| Condition | Readiness reason |
| --- | --- |
| `aiMetadata: false` | `AI_METADATA_EXTRACTION_READINESS_REASON_DISABLED_BY_USER` |
| No global OTel provider | `AI_METADATA_EXTRACTION_READINESS_REASON_OTEL_PROVIDER_MISSING` |
| Global OTel provider found, but SDK did not add the span processor | `AI_METADATA_EXTRACTION_READINESS_REASON_OTEL_SPAN_PROCESSOR_NOT_ADDED` |
| AIME span processor added | `AI_METADATA_EXTRACTION_READINESS_REASON_READY` |

The SDK should report AIME even when disabled by the user. In that case, `readiness_reason` should be `DISABLED_BY_USER` and `otel_setup` can remain unset/default.

## Extended Traces

Answers:

- Is ExT ready?
- Was the ExT middleware added to the app?
- Which ExT behavior did the user choose?
- Which OTel setup path was used?
- OTel:
    - Is there a provider?
    - Was the provider first-party, user-provided, or legacy SDK-created?
    - Did we attempt to add the ExT span processor?
    - Does the provider support the SDK's span processor attachment path?

```protobuf
message ExtendedTraces {
  // Why ExT is or is not ready in this app.
  ExtendedTracesReadinessReason readiness_reason = 1;

  // User-visible ExT configuration observed by the SDK.
  ExtendedTracesConfig config = 2;

  // How the SDK attempted to add the ExT span processor to the global
  // OpenTelemetry provider.
  OTelSetup otel_setup = 3;
}

message ExtendedTracesConfig {
  // The configured ExT setup mode. If the middleware was not registered, this
  // should be EXTENDED_TRACES_BEHAVIOR_UNSPECIFIED.
  ExtendedTracesBehavior behavior = 1;
}

enum ExtendedTracesReadinessReason {
  // The SDK did not report a specific readiness reason.
  EXTENDED_TRACES_READINESS_REASON_UNSPECIFIED = 0;

  // ExT is enabled and the SDK added its span processor to the global
  // OpenTelemetry provider.
  EXTENDED_TRACES_READINESS_REASON_READY = 1;

  // ExT requires explicit setup and the user has not registered the middleware.
  EXTENDED_TRACES_READINESS_REASON_NOT_ENABLED_BY_USER = 2;

  // The user explicitly turned ExT off with behavior: "off".
  EXTENDED_TRACES_READINESS_REASON_DISABLED_BY_USER = 3;

  // ExT is enabled, but no global OTel provider was available for the SDK to
  // extend.
  EXTENDED_TRACES_READINESS_REASON_OTEL_PROVIDER_MISSING = 4;

  // The SDK found an OTel provider, but did not add its ExT span processor.
  EXTENDED_TRACES_READINESS_REASON_OTEL_SPAN_PROCESSOR_NOT_ADDED = 5;

  // The SDK tried to create a legacy OTel provider, but provider creation failed.
  EXTENDED_TRACES_READINESS_REASON_OTEL_PROVIDER_CREATION_FAILED = 6;
}

enum ExtendedTracesBehavior {
  // ExT was not configured, or the SDK could not determine the configured
  // behavior.
  EXTENDED_TRACES_BEHAVIOR_UNSPECIFIED = 0;

  // The SDK should extend an existing global OpenTelemetry provider.
  EXTENDED_TRACES_BEHAVIOR_EXTEND_PROVIDER = 1;

  // The user explicitly disabled ExT.
  EXTENDED_TRACES_BEHAVIOR_OFF = 2;

  // The SDK first tries to extend an existing provider, then falls back to
  // deprecated provider creation.
  EXTENDED_TRACES_BEHAVIOR_AUTO = 3;

  // The SDK uses the deprecated provider creation path.
  EXTENDED_TRACES_BEHAVIOR_CREATE_PROVIDER = 4;

  // The user supplied a behavior value the SDK did not recognize.
  EXTENDED_TRACES_BEHAVIOR_UNKNOWN = 5;
}
```

Readiness mapping:

| Condition | Readiness reason |
| --- | --- |
| Middleware absent | `EXTENDED_TRACES_READINESS_REASON_NOT_ENABLED_BY_USER` |
| `behavior: "off"` | `EXTENDED_TRACES_READINESS_REASON_DISABLED_BY_USER` |
| `behavior: "extendProvider"` and no global OTel provider | `EXTENDED_TRACES_READINESS_REASON_OTEL_PROVIDER_MISSING` |
| `behavior: "extendProvider"` and the provider could not be extended | `EXTENDED_TRACES_READINESS_REASON_OTEL_SPAN_PROCESSOR_NOT_ADDED` |
| `behavior: "auto"` and an existing provider was extended | `EXTENDED_TRACES_READINESS_REASON_READY` |
| `behavior: "auto"` and legacy provider creation succeeded | `EXTENDED_TRACES_READINESS_REASON_READY` |
| `behavior: "auto"` and neither provider extension nor legacy provider creation succeeded | `EXTENDED_TRACES_READINESS_REASON_OTEL_PROVIDER_CREATION_FAILED` |
| `behavior: "createProvider"` and legacy provider creation succeeded | `EXTENDED_TRACES_READINESS_REASON_READY` |
| `behavior: "createProvider"` and legacy provider creation failed | `EXTENDED_TRACES_READINESS_REASON_OTEL_PROVIDER_CREATION_FAILED` |

The SDK should report ExT even when the middleware is absent. In that case, `readiness_reason` should be `NOT_ENABLED_BY_USER`, `config.behavior` should be `UNSPECIFIED`, and `otel_setup` can remain unset/default.

## Send events

Answers:

- Is event sending ready?
- Is there an event key?
- Was the Event API origin overridden?

```protobuf
message SendEvents {
  // Why event sending is or is not ready.
  SendEventsReadinessReason readiness_reason = 1;

  // Relevant configs.
  SendEventsConfig config = 2;
}

message SendEventsConfig {
  // Whether the SDK has an event key available from client options or env.
  bool has_event_key = 1;

  // Whether the user configured an Event API origin override.
  bool has_event_api_origin_override = 2;
}

enum SendEventsReadinessReason {
  // Unused.
  SEND_EVENTS_READINESS_REASON_UNSPECIFIED = 0;

  // Prerequisites met for sending events.
  SEND_EVENTS_READINESS_REASON_READY = 1;

  // SDK does not have an event key.
  SEND_EVENTS_READINESS_REASON_EVENT_KEY_MISSING = 2;
}
```

Readiness mapping:

| Condition | Readiness reason |
| --- | --- |
| SDK is in Dev mode | `SEND_EVENTS_READINESS_REASON_READY` |
| SDK is in Cloud mode and has an event key | `SEND_EVENTS_READINESS_REASON_READY` |
| SDK is in Cloud mode and has no event key | `SEND_EVENTS_READINESS_REASON_EVENT_KEY_MISSING` |

# Docs

No changes.

# Testing

Add a server-side test for feature kind mapping that compares the helper's supported feature names against the `FeatureObservation.feature` protobuf descriptor. The test should fail when a new `oneof` feature field is added without updating the helper mapping.

Add a server-side test for protobuf JSON handling that verifies observations are emitted with protobuf JSON mapping: `lowerCamelCase` field names, numeric enum values, and the expected `oneof` object shape.

Add server-side tests that verify feature observations do not affect registration checksums or app versioning.

Add server-side app sync tests that verify a duplicate sync still updates the app's latest feature observations when only `feature_observations` changed. This should cover the dedupe path where the checksum is unchanged and function synchronization is skipped.

# Alternatives

## Generic JSON feature details

A generic `feature_id + JSON` model would be the most flexible, but it would push parsing and validation to the Inngest server. That makes cross-SDK drift more likely and weakens type safety.

# Glossary

- AIME: AI Metadata Extraction
- ExT: Extended Traces
- SDK feature observations: app-level feature readiness/configuration reported by SDKs during sync
