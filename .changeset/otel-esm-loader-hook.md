---
"inngest": minor
---

Add `inngest/experimental/otel-register`, a `node --import`-able entrypoint that registers OpenTelemetry's ESM loader hook so `extendedTracesMiddleware`'s `"createProvider"`/`"auto"` instrumentation can patch ES modules. Also warn when module instrumentation is detected to be inactive in ESM apps, where extended traces would otherwise silently miss spans from modules like `http`, databases, and AI SDKs.
