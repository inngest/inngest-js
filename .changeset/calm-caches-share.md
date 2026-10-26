---
"@inngest/ci": minor
---

Machines and snapshots a run owns are cleaned up when the run ends for any reason, including cancel and timeout. Needs `inngest` 4.26.0 or later. Cached snapshots are named only by job and cache key (`ci/cache/<job>/<key>`), so pull requests and branches share them, and only the default branch writes them. A pull request whose key is the default branch's uses that entry, and if it is missing builds it from the default branch's commit. A pull request whose key differs, including one from a fork, gets a cache of its own that every run of that pull request shares and that is deleted when the pull request closes (or by the platform's snapshot expiry if the close is never seen). Pushes to other branches keep what they build to themselves. Removes `cache.scope`. A named snapshot taken over a name that an expired snapshot held deletes that snapshot.
