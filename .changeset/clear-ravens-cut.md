---
"inngest": patch
---

`extendedTracesMiddleware()` no longer replaces your app's global OpenTelemetry diagnostic logger when it has no span processor of its own — with `behaviour: "off"`, or when `"extendProvider"` finds no provider to extend. It previously swallowed diagnostics from your own exporters in those cases.
