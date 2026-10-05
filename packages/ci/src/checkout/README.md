# checkout

Getting the repository onto a machine and reacting to what changed.

- `checkout.ts`: `checkout()`, from a local working tree or a GitHub clone.
- `tarball.ts`: the tar of the local working tree that `checkout()` uploads.
- `changed.ts`: `changed()` and the changed-file list, including the local git diff.
- `wait.ts`: `waitForHttp()` and `waitForPort()`.
- `shard.ts`: `shard()`, splitting files evenly across shards.
