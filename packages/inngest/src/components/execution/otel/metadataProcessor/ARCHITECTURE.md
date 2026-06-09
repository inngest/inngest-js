# AI Metadata Processor

## Purpose

Extract a small allowlist of AI OpenTelemetry attributes and attach them to Inngest step metadata. This processor observes spans only; it does not export traces.

## Mental Model

OTel span processors are process-global, but Inngest clients are not. A process can have multiple Inngest clients, and every registered OTel processor sees every recording span. The metadata processor handles this by treating the Inngest execution root span as its ownership boundary.

`Inngest` registers one metadata processor per client. When an execution starts, the engine declares the `inngest.execution` root span through `clientProcessorMap`. The processor then follows only child spans under that declared root and ignores unrelated spans from the rest of the process.

Step association is captured when a child span starts. Checkpointing executions declare the active step through `declareStepExecution()` / `clearStepExecution()`; non-checkpointing executions use the active execution context because the engine does not call those step lifecycle methods today. When the span ends, the processor extracts AI metadata and adds one `inngest.ai` merge update to the captured step.

## Files

- `processor.ts`: OTel lifecycle, root ownership, step association, and metadata writes.
- `libExtractors/`: library/schema-specific attribute extraction. Extractors do not know about Inngest execution state.
- `metadata.ts`: shared metadata kind, key names, and AI aggregation rules.
- `instrumentations.ts`: AI instrumentation registration.

## Extended Traces Patterns Reused

Extended Traces is a separate feature and may or may not be enabled for a client. AI metadata must behave the same either way.

Provider setup mirrors Extended Traces: first try to extend the current OTel provider, otherwise create a `BasicTracerProvider`. Metadata-only provider creation waits behind in-flight Extended Traces provider creation, so both features land on the same provider when enabled together.

The processor also reuses the execution lifecycle shape: `declareStartingSpan()` marks the root span, and checkpointing step lifecycle calls scope spans to active steps. AI-specific instrumentations are registered here, not in Extended Traces, so metadata behavior is the same with or without Extended Traces enabled.

## Metadata

```json
{
  "input-tokens": 15,
  "output-tokens": 21,
  "model": "gpt-4o-mini"
}
```

Supported input schemas are Vercel AI SDK `ai.*` attributes and GenAI semantic convention `gen_ai.*` attributes, such as those emitted by OpenAI instrumentation.

Each qualifying top-level AI span writes one merge update. The execution metadata buffer aggregates `inngest.ai` step updates before sending metadata: repeated numeric keys are summed, and non-numeric keys follow merge semantics by keeping the latest value.

## Invariants

- Only process spans under a root span declared to this processor.
- Do not attach metadata without a step.
- Keep extractors limited to span matching and metadata extraction.
- Keep metadata key names in `metadata.ts`.
- Call `addMetadata()` once per qualifying span; the execution metadata buffer applies the `metadata.ts` aggregation helper before sending step metadata.
