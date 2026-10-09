---
"@inngest/ci": minor
---

Build a `from` parent, and a cached job, in a run of its own with one generated `ci/build` function, so children of one parent share one build. Add an `input` schema (any Standard Schema) to `ci.job()` to validate a job's input.

A cache is now named for its app as well as its repository, so two apps in one repository and environment no longer restore each other's snapshots. Existing cache names change once, so the first run after upgrading builds cold.
