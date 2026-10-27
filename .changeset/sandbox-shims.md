---
"inngest": patch
---

Experimental: command shims for Sandboxes. `tool.shim()` makes a program on the command's `PATH` call a handler in your app first. The handler gets the command's `sandbox`, so it can do privileged work in your app and reply with the result, run the real program (as called, or with another `argv`, extra `env` or `stdin`), or refuse. Credentials never need to enter the sandbox:

```ts
import { tool } from "inngest/experimental";

const git = tool.shim.git({
  remote: "https://github.com/acme/app.git",
  token: () => installationToken("acme/app"),
  policy: (push) => {
    if (!push.branch?.startsWith("agent/")) {
      return { refuse: "agents push to agent/* branches" };
    }

    return undefined;
  },
});

await sandbox.$({
  shims: [
    git,
    tool.shim("terraform", ({ argv, run, refuse }) => {
      return argv[0] === "apply" ? refuse("apply goes through a pull request") : run();
    }),
    tool.shim.config({ REGION: "iad" }),
  ],
}).sh`git clone https://github.com/acme/app.git work && cd work && terraform plan && git push origin HEAD:agent/fix`;
```

`tool.shim.git()` runs `git clone` and `git fetch` on your side and unpacks them into the sandbox, and `git push` bundles in the sandbox, brings the bundle home, runs your `policy` (branch rules, changed paths, the patch for a secret scan) and pushes from your app with a token only your app holds. `shims` is accepted by `commands.run()` and `$` and takes only `tool.shim()` values. Code in the sandbox reads settings with `inngest-tool config NAME` and lists the shims with `inngest-tool shims`. Commands with tools or shims can now run longer than five minutes, `exitCodes` works with them, and a timeout fails as a `sandbox_exec_timed_out` error. Shims use a small static `inngest-tool` binary that the SDK puts into the sandbox when it is missing.
