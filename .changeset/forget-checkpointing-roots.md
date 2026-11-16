---
"inngest": patch
---

Fix a memory leak with Extended Traces: `InngestSpanProcessor` now forgets an execution's root span ID once that span ends, instead of keeping one ID per run for the life of the process.
