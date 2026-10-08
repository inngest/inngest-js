---
"@inngest/ci": patch
---

Mistakes in a job's or matrix's `from` fail when the app boots: a parent from another CI client, a value that isn't a job, and `job.with(input)` input that fails the parent's `input` schema. A `from` function that leads back to a job already being started from fails once, naming the cycle, instead of building forever.
