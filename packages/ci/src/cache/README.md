# cache

Job caching. A cached job is the snapshot of its machine, named `ci/<scope>/<job>/<key>`; there is no other store.

- `cache.ts`: keys and scopes, snapshot names, looking a snapshot up by name, deleting a bad one, and the `files()` key helper. A job's key includes the snapshot of the parent it starts from, so a parent that changed means a new name.
- `localCache.ts`: hashing local working-tree files for `files()` keys.
