# AI Metadata Processor

## Purpose

Extract a small allowlist of AI OpenTelemetry attributes and attach them to Inngest step metadata. This processor observes spans only; it does not export traces.

## Mental Model

OTel span processors are process-global, but Inngest clients are not. A process can have multiple Inngest clients, and every registered OTel processor sees every recording span. The metadata processor handles this by treating the Inngest execution root span as its ownership boundary.

`Inngest` registers one process-level metadata processor with OTel. When an execution starts, the engine declares the `inngest.execution` root span directly on that singleton and includes a metadata callback for that execution. The processor tracks descendants under that declared root; each tracked span points to the same root context, so extracted AI values route to the owning execution callback.

The processor does not know about steps. When a span ends, it extracts AI metadata and emits the values through the captured root callback. The execution engine owns step attribution: if a step is active when the callback runs, the engine adds one `inngest.ai` merge update to that step's metadata buffer.

## Files

- `processor.ts`: OTel lifecycle, root ownership, and extracted metadata callback routing.
- `provider.ts`: AI Metadata's feature-owned OTel create/extend setup.
- `libExtractors/`: library/schema-specific attribute extraction. Extractors do not know about Inngest execution state.
- `metadata.ts`: shared metadata kind, key names, and AI aggregation rules.

## Extended Traces Patterns Reused

Extended Traces is a separate feature and may or may not be enabled for a client. AI metadata must behave the same either way.

Provider setup intentionally mirrors Extended Traces instead of sharing its helper code: first try to extend the current OTel provider, otherwise create a `BasicTracerProvider` with the same default instrumentations. Provider creation uses the shared OTel setup mutex so AI Metadata and Extended Traces cannot race to install different global providers. The Extended Traces processor still only exists when the Extended Traces middleware is enabled; AI metadata registers its own singleton processor independently.

The processor also reuses the execution lifecycle shape: `declareStartingSpan()` marks the root span. AI Metadata owns its processor and setup so the feature works the same with or without Extended Traces enabled.

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
- Keep step attribution in the execution engine.
- Keep extractors limited to span matching and metadata extraction.
- Keep metadata key names in `metadata.ts`.
- Emit one metadata callback per qualifying span; the execution metadata buffer applies the `metadata.ts` aggregation helper before sending step metadata.
