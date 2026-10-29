---
"inngest": minor
---

`repo()` brings an existing checkout up to date instead of failing. When `path` already holds a repository, as in a sandbox restored from a thread's snapshot or recycled mid-run, it fetches and moves the working copy to `ref`; `Repo.action` says `"cloned"` or `"synced"`.

```ts
const checkout = await repo(sandbox, {
  repo: "acme/web",
  ref: "main",
  sync: "keep", // or "reset" (default)
});
```

`sync: "reset"` makes the working copy `ref` as the remote has it, discarding local commits, changes and untracked files (ignored files and submodules are left alone), and repoints a checkout of another repository. `sync: "keep"` discards nothing: it checks out `ref`, fast-forwards the branch when it can, carries uncommitted changes, leaves a branch with local commits where it is, moves commits only a detached HEAD held to a `detached-<sha>` branch, and fails rather than touch a checkout of another repository or overwrite local changes.

Git hooks are off for the clone, fetch and push `repo()` runs, because the checkout is writable by the model and a hook could read the token; a repository that needs a `pre-push` hook (Git LFS, for one) does not get it. The token is given only to the process that talks to the remote, a push goes to the repository's URL whatever the checkout's config says, and URL rewrite rules planted in the checkout are removed first.
