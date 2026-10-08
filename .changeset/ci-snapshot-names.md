---
"@inngest/ci": minor
---

Cached snapshots are now found by name across runs, and there is no fallback to unnamed snapshots: a snapshot the server refuses to name fails the build with the reason. Requires `inngest` 4.23.0 or later.
