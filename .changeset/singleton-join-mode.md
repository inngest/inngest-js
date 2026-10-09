---
"inngest": minor
---

Add `singleton: { mode: "join" }`. When a run started by `step.invoke()` would be skipped because a singleton run is already active, the invoking run now resolves with the active run's result (or error) instead of waiting for its invoke to time out. Requires an Inngest server that supports the `join` mode.
