---
"inngest": patch
---

Attach `inngest.sandbox` metadata to every `step.sandbox` step, describing the sandbox action, the method called, and the machine, command, process, or snapshot involved. A `snapshot()` call's create and readiness wait share one trace span, using a new internal, unstable `group["~span"]()` scope and `"~span"` step option that group steps under nested spans, each with an optional `kind`.
