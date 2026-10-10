---
"@inngest/ci": patch
---

A cached job that a run had to build while the jobs that start from it waited now says so: on the "Look up cache" row of its lookup, and in the pipeline check's warnings, once per job. A job without `cache.refresh` is told to add it to build it ahead of time; one with it is told its `cache.refresh` triggers hadn't built a usable snapshot for these inputs yet.
