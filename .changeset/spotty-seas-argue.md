---
"inngest": patch
---

Preserve third-party OpenTelemetry async context (e.g. from Langfuse's `propagateAttributes`) inside `step.run()` callbacks.