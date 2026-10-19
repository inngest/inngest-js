---
"@inngest/ci": patch
---

A job's machines are now destroyed as soon as the job passes or fails, instead of when the whole pipeline run ends. A cached snapshot is also no longer deleted when a machine fails to launch or times out while starting from it.
