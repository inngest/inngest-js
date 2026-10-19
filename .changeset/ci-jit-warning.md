---
"@inngest/ci": patch
---

You now get a warning when a run has to build a cached job on the spot while other jobs wait for it. Add `cache.refresh` to build it ahead of time.
