# cache

Job caching. A cached job is the snapshot of its machine, named `ci/<scope>/<job>/<key>`; there is no other store.

- `cache.ts`: keys and scopes, snapshot names, looking a snapshot up by name, checking the parents a snapshot was built from, deleting a bad one, and the `files()` key helper.
- `localCache.ts`: hashing local working-tree files for `files()` keys.

What a snapshot knows about itself (its working tree and the cached snapshots it was built from) lives in a file inside it: see `../machine/snapshotMeta.ts`.
