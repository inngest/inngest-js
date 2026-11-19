---
"inngest": patch
---

Fix a remaining memory leak with Extended Traces: when the tracer's sampler dropped an execution's root span, `InngestSpanProcessor` could still keep that span's ID for the life of the process. The execution engine now tells the processor when an execution finishes, so cleanup no longer depends on the root span being recorded.
