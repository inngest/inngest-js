---
"inngest": minor
---

`sandbox.tools.git()` in `inngest/experimental` gives an agent a `git_push` tool that holds the credentials, so the sandbox never does. The model names a branch; the function bundles it in the sandbox, checks what it really changes with your `policy` (branch, paths, commits, the patch text), and pushes with a token only your app holds. A policy refusal comes back to the model as an error it can act on.

```ts
const workbench = sandbox({
  id: "workbench",
  tools: sandbox.tools.git({
    remote: "https://github.com/acme/site.git",
    token: () => mintInstallationToken(),
    policy: (push) => {
      if (!push.branch?.startsWith("agent/")) {
        return { refuse: "agents push to agent/* only" };
      }
    },
  }),
});
```
