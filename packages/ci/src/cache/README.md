# cache

Job caching. A cached job is the snapshot of its machine, named `ci/cache/<job>/<key>` (only the default branch writes it; a pull request whose key differs writes `ci/pr:<number>/<job>/<key>`, held by `ci/pr-cache` until it closes; a local run writes `ci/local/<job>/<key>`; a run's own snapshots are `ci/run:<root run>/<job>/<key>`, deleted when the run ends); there is no other store.

- `cache.ts`: keys, where a run writes (`cacheLane`), snapshot names, looking a snapshot up by name, deleting a bad one, and the `files()` key helper. A job's key includes the snapshot of the parent it starts from, so a parent that changed means a new name.
- `localCache.ts`: hashing local working-tree files for `files()` keys.
