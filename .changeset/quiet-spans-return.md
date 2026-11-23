---
"inngest": patch
---

Fix missing auto-instrumentation spans in `extendedTracesMiddleware()` on fresh installs. `@opentelemetry/auto-instrumentations-node` 0.82.0 moved to OpenTelemetry SDK 3.x and `@opentelemetry/api` 1.10, so npm installed a second API copy and its HTTP, database and framework spans were not recorded. The range is now capped at `<0.82.0`, matching the existing `<0.300.0` caps on the other OpenTelemetry packages.
