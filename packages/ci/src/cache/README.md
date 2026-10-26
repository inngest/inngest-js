# cache

Job caching. A cached job is the snapshot of its machine, named `ci/cache/<job>/<key>` (a local run writes `ci/local/<job>/<key>`; a run's own snapshots are `ci/run:<root run>/<job>/<key>`, deleted when the run ends); there is no other store.

- `cache.ts`: keys, where a run writes (shared, local or its own), snapshot names, looking a snapshot up by name, deleting a bad one, and the `files()` key helper. A job's key includes the snapshot of the parent it starts from, so a parent that changed means a new name.
- `localCache.ts`: hashing local working-tree files for `files()` keys.
