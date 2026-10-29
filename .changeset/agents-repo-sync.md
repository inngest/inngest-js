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

The token is only in the environment of the one git process that talks to the remote, and that process runs in a throwaway repository, so nothing in the checkout's config (a rewrite rule, a second URL, a proxy, a credential helper, an include) can redirect or intercept it. A push goes to the repository's URL. Git hooks are off for these commands, because the checkout is writable by the model and a hook could read the token; a repository that needs a `pre-push` hook (Git LFS, for one) does not get it. The user's global git config is ignored while a token is in use.
