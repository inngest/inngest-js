---
"inngest": minor
---

The global `step` and `group` now include tools added by middleware, like `step.sandbox` and `group.sandbox`, and `step.fetch` works through the global `step`. Use `export const { step, group } = inngest.globals()` to get them typed for your client, so helpers don't need `step` passed in. Global tools now find steps in the same tick as the function's own.
