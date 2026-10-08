---
"@inngest/ci": patch
---

A job that starts from a cached parent with no usable snapshot now says so on its "Start from" row, and the pipeline check's warnings name every cached parent or ancestor built just in time while jobs waited. A parent without `cache.warm` is told to add it; one with it is told its inputs changed since the last warm build.
