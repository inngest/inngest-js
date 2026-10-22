---
"inngest": patch
---

Experimental: middleware can now provide functions. A middleware class with a static `functions({ client })` hook returns functions that `serve()` and `connect()` add to the app's own, unless the app already serves one with the same ID. Without the middleware on the client, nothing is added. `sandboxMiddleware()` uses it to serve the sandbox cleanup function.
