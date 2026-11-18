---
"@inngest/ci": minor
---

A cache entry that a changed key replaces is now deleted when the new one is saved, rather than left to expire. Existing caches stay warm: the names of cached jobs' snapshots are unchanged, and a build run already in flight when you upgrade still finishes. Requires `inngest` 4.27.0 or later, which adds `snapshotCache` to `inngest/experimental`.
