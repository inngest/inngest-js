---
"inngest": minor
---

Add `set()` to the experimental metadata builders (`inngest.metadata` and `step.metadata()`), which replaces all values for a metadata kind, and deprecate `update()` in favor of it.

The SDK now sends metadata writes as `set`. Repeated `update()` calls to the same kind within a single step are still merged, but `update()` calls to the same kind from different steps, or sent via the API (IE targeting another run/step/attempt/span or made outside of a step), now replace each other instead of merging.
