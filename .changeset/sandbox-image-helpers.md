---
"inngest": patch
---

Add `image.inngest(name)` and `image.custom(ref)`, passed as `from` to `inngest.sandboxes.create()` and `step.sandbox.create()` to choose the image a Sandbox starts from. `from` cannot be combined with `image` or a snapshot.
