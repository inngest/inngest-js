---
"inngest": patch
---

Sandboxes created with `await using` or `group.sandbox()` are now destroyed even when their run is cancelled or times out. Apps that use `sandboxMiddleware()` serve the cleanup function automatically; sandboxes made with a plain `step.sandbox.create()` are still left running for you to keep.
