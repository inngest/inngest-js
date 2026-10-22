---
"inngest": patch
---

Sandboxes created with `await using` or `group.sandbox()` are now destroyed, by ID, even when their run is cancelled or times out. Sandboxes made with a plain `step.sandbox.create()` are still left running for you to keep.
