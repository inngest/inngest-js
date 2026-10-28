---
"@inngest/ci": minor
---

A cache entry that a changed key replaces is now deleted when the new one is saved, rather than left to expire. Requires an `inngest` version with `snapshotCache`. TODO: set the `inngest` peer range of `@inngest/ci` to the first release containing `snapshotCache` (agent-primitives is still 4.26.1, unreleased).
