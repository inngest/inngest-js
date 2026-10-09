---
"@inngest/ci": minor
---

Jobs declare the job they start from with a `from` option, replacing `from()` inside the handler: `ci.job({ id: "test", from: install }, …)`. A parent that takes input is given it with `job.with(input)`, and `from` can be a function of the job's own input. Matrices take `from` too. To move, delete the `await from(parent)` line and add `from: parent` to the job's options.
