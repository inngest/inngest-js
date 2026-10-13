---
"inngest": patch
---

Experimental: add `group.sandbox(idOrOptions, async (sandbox) => { ... })`, available with `sandboxMiddleware()`. It creates a sandbox, runs your callback with it, and destroys it when the callback ends, so the sandbox's whole lifetime shows as one `sandbox` group in the trace. Pass an ID, or the same options as `step.sandbox.create()` plus an `id`. If the callback fails with an error that will be retried, the sandbox is kept so the retry can reuse it, and destroyed once the failure is final.
