---
"inngest": patch
---

Add `Inngest.removeFunctions()` to remove functions from the client's local registry. `createFunction()` adds every created function to the client's registry (`client.funcs`); in long-lived processes, for example module-level singletons or app factories invoked per test, per tenant or plugin instance, or on hot reload, closed functions stay reachable along with everything their handler closures captured. Call `removeFunctions()` with the app's functions when the app closes so they can be garbage-collected. Without this call, memory growth from retained functions does not stop.
