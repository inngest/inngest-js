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

`sync: "reset"` makes the working copy exactly `ref`, discarding local commits, changes and untracked files. `sync: "keep"` discards nothing: it checks out `ref`, fast-forwards the branch when it can, carries uncommitted changes, and leaves a branch with local commits where it is.
