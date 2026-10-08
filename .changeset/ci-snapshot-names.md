---
"@inngest/ci": minor
---

Cached snapshots are now found by name across runs, and the CLI no longer falls back to unnamed snapshots: a snapshot the server refuses to name fails the build with the reason. Requires `inngest` 4.23.0 or later.
