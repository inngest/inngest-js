---
"@inngest/ci": minor
---

Machines and snapshots a run owns are cleaned up when the run ends for any reason, including cancel and timeout. Cached snapshots are named only by job and cache key, so pull requests and branches share them; a pull request from a fork still reads the cache but never writes it. Removes `cache.scope`. A rebuilt cache entry also deletes the expired snapshot that held its name.
