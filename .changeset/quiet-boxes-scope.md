---
"inngest": minor
---

Add experimental `step.sandbox.scope({ sandboxId } | { snapshotId })`, which destroys the sandbox or deletes the snapshot by ID when the run ends for any reason, including cancel and timeout, through the same cleanup as `await using` and `group.sandbox()`. It returns a handle whose `abort()` stops the cleanup once you have removed the resource yourself.
