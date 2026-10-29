---
"@inngest/ci": patch
---

Delete a run's snapshots when the run is cancelled or times out, and delete the cache snapshot a new one replaces, so Sandboxes snapshots no longer pile up until the environment's limit.
