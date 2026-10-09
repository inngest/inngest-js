---
"@inngest/middleware-sentry": patch
---

Stop forcing the sampled flag in the synthesized `sentry-trace`, so the app's `tracesSampleRate` / `tracesSampler` is respected. Previously the middleware always propagated `sampled=1`, which made the SDK inherit a "parent sampled" decision and export 100% of run/step spans even with `tracesSampleRate: 0`. Trace continuity (the deterministic run-derived trace ID) is unchanged. Apps that relied on the forced sampling should now set `tracesSampleRate` (or `tracesSampler`) explicitly.
