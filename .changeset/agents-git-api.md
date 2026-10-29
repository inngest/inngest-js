---
"inngest": patch
---

`git_push` now works without `git` on the machine that runs your app, so an agent can run on Cloudflare Workers or any runtime with `fetch`. With `transport: "auto"` (the default) it uses the host's git when it runs and otherwise rebuilds the commits on a github.com remote with the GitHub Git Data API; `transport: "api"` with `api` reaches GitHub Enterprise. The same `GitPolicy` checks the push, and the token still never enters the sandbox. History must be linear on top of the remote's branch (no merge commits, signed commits or submodule changes).

`commitFiles()` commits a set of files to a repository from your app with no sandbox, under the same policy. `pushBranch()` is the typed, directly callable form of the tool. A policy may return `notes`, which come back in the push result (`PushedRef.notes`, and in the tool's result) so an audit trail survives the push step replaying. Files a policy reads carry their git `mode`.
