---
"inngest": minor
---

A thread's sandbox is now paused, not destroyed, when its run is done with it, and the thread's next message resumes it, so the workspace (a checkout, `node_modules`) comes back whole with no snapshot and no size cap. It is the default of an agent's `sandboxes`; `{ sandbox, idle: "snapshot" }` keeps the old save-and-destroy, and a sandbox that can't be paused or resumed falls back to the thread's snapshot, then to a fresh sandbox. `idle` replaces the inert `keepAlive`, which is removed.

`repo()` can now push from the host: `repo(sandbox, { repo, token: readOnlyToken, push: { token: writeToken, policy } })` clones and fetches in the sandbox with a read-only token, and pushes through the `git_push` checks with a write token the sandbox never holds.

The git-free push of `git_push` sends fewer requests: text files go inside the trees, the other blobs are uploaded together a few at a time, the files a policy's `patch()` reads are fetched together, and a manifest that compresses to what a step can read is read in one step instead of in pieces.

The testing entry's `fakeSandbox()` now serves pause and resume (and answers 404 for a destroyed sandbox), and `fakeGitDataApi()` accepts tree entries with inline `content`.
