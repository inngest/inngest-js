---
"@inngest/ci": patch
---

You now get a warning when a run has to build a cached job on the spot while other jobs wait for it, with what to do about it: add `cache.refresh` so it builds ahead of time, or check that your `cache.refresh` triggers are building it.
