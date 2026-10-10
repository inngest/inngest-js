---
"@inngest/ci": minor
---

Concurrent runs that miss the same cached job now build it once. A run listens for `ci/build.done`, looks the snapshot up, and on a miss sends `ci/build.requested`; the `ci/build` function that takes it builds on a machine named for the cache entry, so only one build runs, and every run adopts the snapshot from the event it ends with. Add `buildWait` to `createCi()` to set how long a run waits before it checks that the build is still going.
