---
"@inngest/ci": patch
---

Snapshots no longer pile up. A run's own snapshots are deleted however it ends, including when it is cancelled, and a cached job's new key deletes the entry it replaces.

A snapshot that can't be saved, such as when the environment's snapshot limit is reached, now fails the job with a clear error instead of silently re-running its parent in every job that starts from it.
