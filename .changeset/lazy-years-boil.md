---
"inngest": patch
---

Deprecate Extended Traces provider creation. `behaviour: "createProvider"` and the `"auto"` fallback remain functional, but now direct users to preload `@inngest/otel/node` and extend that provider instead.
