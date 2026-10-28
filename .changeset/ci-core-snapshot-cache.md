---
"@inngest/ci": minor
---

A job's cached snapshot now makes room for itself. When the environment is at its Sandboxes snapshot limit, saving a cache entry deletes expired and failed snapshots and older versions of the same entry, then pull request snapshots oldest first, and tries again. Snapshots of branches and of running pipelines are never deleted this way. A cache entry that a changed key replaces is also deleted when the new one is saved, rather than left to expire. Requires an `inngest` version with `snapshotCache`. TODO: set the `inngest` peer range of `@inngest/ci` to the first release containing `snapshotCache` (agent-primitives is still 4.26.1, unreleased).
