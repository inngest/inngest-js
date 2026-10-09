---
"@inngest/ci": minor
---

Build a `from` parent, and a cached job, in a run of its own with one generated `ci/build` function, so children of one parent share one build. Add an `input` schema (any Standard Schema) to `ci.job()` to validate a job's input.

A cache is now named for its app as well as its repository, so two apps in one repository and environment no longer restore each other's snapshots. Existing cache names change once, so the first run after upgrading builds cold.

A snapshot that fails to start is retried once before it is treated as broken, and a broken one is deleted once, however many jobs found it. A single timeout no longer deletes a cached snapshot that other runs share, such as the base branch's.

A cached job that starts from a job without a `cache` is no longer given a cache name. Its snapshot could never be found again, so each run left a new one behind. It now builds in every run, its snapshot belongs to the run and is deleted with it, and the run warns until the job above it has a `cache`.
