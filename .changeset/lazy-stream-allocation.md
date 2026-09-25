---
"inngest": patch
---

Stop allocating a `TransformStream` for every execution. Streams are now created lazily, only when a run actually streams or a consumer reads the SSE response, which avoids per-execution Web Streams allocation and the Bun GC retention it amplified.
