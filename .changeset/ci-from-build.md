---
"@inngest/ci": minor
---

Build a `from` parent, and a cached job, in a run of its own with one generated `ci/build` function, so children of one parent, and jobs further down its chain, share one build within a pipeline run. Across concurrent runs that miss at the same time it is best-effort: they may build redundantly, at most one snapshot keeps the name and the others adopt it. Add an `input` schema (any Standard Schema) to `ci.job()` to validate a job's input.

A cache is now named for its app as well as its repository, so two apps in one repository and environment no longer restore each other's snapshots. Existing cache names change once, so the first run after upgrading builds cold.

A snapshot that fails to start is retried once before it is treated as broken, and a broken one is deleted once, however many jobs found it. A single timeout no longer deletes a cached snapshot that other runs share, such as the base branch's.

A cached job that starts from a job without a `cache` is no longer given a cache name. Its snapshot could never be found again, so each run left a new one behind. It now builds in every run, its snapshot belongs to the run and is deleted with it, and the run warns until the job above it has a `cache`.

A build is sent a job's input as given, as JSON, and validates it with the job's `input` schema itself, so a schema that turns a string into a `Date`, or a list into a `Set`, works in a cached job and in a job started from. The input you pass must survive JSON. The build also works out the job's key and snapshot name itself and fails if the ones it was sent don't match.
