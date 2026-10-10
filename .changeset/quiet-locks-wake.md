---
"@inngest/ci": minor
---

Concurrent runs that miss the same cached job now build it once. A run listens for `ci/build.done`, looks the snapshot up, and on a miss sends `ci/build.requested`; the `ci/build` function that takes it builds on a machine named for the cache entry, so only one build runs, and every run adopts the snapshot from the event it ends with. Add `buildWait` to `createCi()` to set how long a run waits before it checks that the build is still going. A run that finds the snapshot by its look returns at once and leaves its wait behind, which needs `inngest` 4.24.1 or later: its SDK completes the run when the handler returns instead of holding it open for the unawaited wait.
