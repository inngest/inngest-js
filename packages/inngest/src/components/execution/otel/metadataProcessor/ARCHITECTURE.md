# AI Metadata Processor

## Purpose

Extract a small allowlist of AI OpenTelemetry attributes and attach them to
Inngest step metadata. This processor observes spans only; it does not export
traces.

## Flow

1. `Inngest` registers one processor per client at construction.
2. Provider setup mirrors Extended Traces: extend the current OTel provider, or
   create a `BasicTracerProvider` if none exists.
3. The execution engine declares the Inngest root span through
   `clientProcessorMap`; checkpointing executions also declare active steps.
4. The processor follows child spans under its declared root and scopes them to
   the current step.
5. On span end, `libExtractors/` matches known AI span schemas and extracts
   metadata for one `inngest.ai` merge update.

## Extended Traces Patterns Reused

- Start from `declareStartingSpan()` and follow child spans by parent span ID.
- Use `declareStepExecution()` / `clearStepExecution()` to scope spans to steps.
- Support OTel v1 `addSpanProcessor()` and OTel v2 internal processor arrays.
- Defer metadata-only provider creation behind in-flight Extended Traces provider
  creation, so Extended Traces can register its instrumentations first.
- Register AI-specific instrumentations here, not in Extended Traces, so
  metadata behavior is the same with or without Extended Traces enabled.

## Metadata

```json
{
  "input-tokens": 15,
  "output-tokens": 21,
  "model": "gpt-4o-mini"
}
```

Supported input schemas are Vercel AI SDK `ai.*` attributes and GenAI semantic
convention `gen_ai.*` attributes, such as those emitted by OpenAI
instrumentation.

Each qualifying top-level AI span writes one merge update. Numeric aggregation is
future work.

## Extractors

Extractors only match spans and extract metadata. They do not know about Inngest
step state, batching, transport, or provider setup.

Emitted metadata key names live in `metadata.ts` and are shared by all
extractors.
