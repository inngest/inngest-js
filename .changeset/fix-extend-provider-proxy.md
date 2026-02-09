---
"inngest": patch
---

Fix `extendProvider()` failing to extend existing OTel providers by unwrapping the `ProxyTracerProvider` returned by `trace.getTracerProvider()`. Previously, the proxy wrapper hid the underlying provider's `addSpanProcessor` method, causing `"auto"` mode to fall through to `createProvider()` and register duplicate instrumentations.
