---
"inngest": patch
---

AI metadata extraction no longer throws `TypeError: Cannot read properties of undefined (reading 'gen_ai.request.model')` when the global tracer provider hands span processors spans without `attributes`, such as dd-trace's OpenTelemetry bridge.
