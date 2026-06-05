# AI Metadata Processor

## Purpose

Extract a small allowlist of AI OpenTelemetry attributes and attach them to
Inngest step metadata. This processor observes spans only; it does not export
traces.

## Flow

1. `Inngest` registers one processor per client at construction.
2. Provider setup mirrors Extended Traces: extend the current OTel provider, or
   create a `BasicTracerProvider` if none exists.
3. The execution engine fans out run and step lifecycle calls through
   `clientProcessorMap`.
4. The processor tracks child spans under the active `inngest.execution` span and
   captures step context when spans start.
5. On span end, `libStrategies/` matches known AI span schemas and extracts
   metadata for `inngest.ai` step updates.

## Extended Traces Patterns Reused

- Start from `declareStartingSpan()` and follow child spans by parent span ID.
- Use `declareStepExecution()` / `clearStepExecution()` to scope spans to steps.
- Ignore infrastructure spans between checkpointed steps.
- Support OTel v1 `addSpanProcessor()` and OTel v2 internal processor arrays.
- Use `FinalizationRegistry` plus explicit cleanup to avoid stale span state.

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

## Strategies

Strategies only match spans and extract metadata. They do not know about Inngest
step state, batching, API fallback, or provider setup.

Emitted metadata key names live in `metadata.ts` and are shared by all
strategies.
