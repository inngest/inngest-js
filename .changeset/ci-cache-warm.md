---
"@inngest/ci": minor
---

Renamed `cache.refresh` to `cache.warm`, and the `ci/cache-refresh/<job>` function to `ci/cache-warm/<job>`. Warming builds a cached job on your triggers so no run waits on a cold build; a warm run does nothing when the cache already hits.
