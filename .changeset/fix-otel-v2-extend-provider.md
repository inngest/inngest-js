---
"inngest": patch
---

Fix `extendProvider()` for OTel SDK v2 where `addSpanProcessor()` was removed.

Move `@opentelemetry/auto-instrumentations-node` and related imports from static top-level to dynamic `await import()` inside `createProvider()`. This prevents module-level monkey-patching side effects that broke `inngest.send()` when combined with host app OTel setups (e.g. Sentry). See #1324.
