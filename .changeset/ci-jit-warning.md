---
"@inngest/ci": patch
---

A job that starts from a cached parent whose snapshot wasn't there now says so on its "Start from" row, and in the pipeline check's warnings: the parent was built just in time while the job waited, and `cache.warm` builds it ahead of time.
