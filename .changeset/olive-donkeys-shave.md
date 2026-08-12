---
"inngest": patch
---

Stop `InngestMetadataSpanProcessor` retaining an execution engine per run when traces are sampled below 100%.

Span processors only receive `onStart`/`onEnd` for recording spans, so tracking a non-recording span seeded an entry in `#spanSinks` that could never be removed, retaining the `AIMetadataSink` closure and the `InngestExecutionEngine` it captures for the lifetime of the process. `trackSpan` now skips non-recording spans.
