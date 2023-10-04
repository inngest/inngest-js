---
"inngest": major
---

All steps require IDs

When using any step.* tool, an ID is now required to ensure that determinism across changes to a function is easier to reason about for the user and the underlying engine.

The addition of these IDs allows you to deploy hotfixes and logic changes to long-running functions without fear of errors, failures, or panics. Beforehand, any changes to a function resulted in an irrecoverable error if step definitions changed. With this, changes to a function are smartly applied by default.

See the [v3 migration guide](https://www.inngest.com/docs/sdk/migration).
