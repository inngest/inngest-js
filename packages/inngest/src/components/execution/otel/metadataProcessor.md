# AI metadata span processor

`InngestMetadataSpanProcessor` is a read-only OpenTelemetry span processor used to extract AI usage metadata from spans created during an Inngest execution. It is independent from `InngestSpanProcessor`, which exports Extended Traces.

## What it tracks

The execution engine declares the root `inngest.execution` span when a run starts and gives the metadata processor a callback for receiving AI metadata found during that execution. Internally, this callback is called the AI metadata sink.

The processor records which spans should use that callback. It starts with the root span, then marks child spans in `onStart()` when their parent is already tracked.

When a tracked span ends, `onEnd()` extracts allowlisted AI metadata from the span's attributes and sends it to the callback. The engine owns aggregation and step attribution.

## Scope cleanup

Tracking is owned by an `AIMetadataScope`, not by the OpenTelemetry trace. The engine starts a scope when the SDK execution begins and ends it when the SDK request/message finishes responding.

This scope exists because OpenTelemetry only gives processors per-span lifecycle callbacks. Ending a parent span does not imply that descendants have ended, and sampled-out/non-recording spans do not call processor lifecycle hooks at all. In other words, scopes allow us to cleanup "endless" spans (avoiding a memory leak).

At scope end, the processor deletes any remaining tracked spans for that execution. This prevents the processor from retaining the AI metadata sink after the SDK can no longer attach late metadata to a step.

## Cleanup paths

Tracked span state is removed in three ways:

- `onEnd()` removes the entry for a span that ended normally.
- `endScope()` removes all entries still owned by a completed SDK execution.
- `FinalizationRegistry` is a best-effort fallback if an unended span becomes unreachable before its scope ends.

The `span.isRecording()` guard avoids tracking spans for which OpenTelemetry will not call processor lifecycle hooks.
