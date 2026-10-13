# checkout

Getting the repository onto a machine and reacting to what changed.

- `checkout.ts`: `checkout()`, from a local working tree or a GitHub clone.
- `tarball.ts`: the tar of the local working tree, or of some of its files, that `checkout()` uploads.
- `tree.ts`: the git tree ID of the uploaded working tree, and the diff between two, so a machine that has a tree gets only the changes.
- `changed.ts`: `changed()` and the changed-file list, including the local git diff.
- `porcelain.ts`: parsing NUL-delimited git status output.
- `wait.ts`: `waitForHttp()` and `waitForPort()`.
- `shard.ts`: `shard()`, splitting files evenly across shards.
