---
"inngest": patch
---

Experimental: command shims for Sandboxes. `tool.shim()` makes a program on the command's `PATH` call a handler in your app first. The handler gets the command's `sandbox`, so it can do privileged work in your app and reply with the result, run the real program (as called, or with another `argv`, extra `env` or `stdin`), or refuse. Credentials never need to enter the sandbox:

```ts
import { tool } from "inngest/experimental";

await sandbox.$({
  shims: [
    tool.shim("terraform", ({ argv, run, refuse }) => {
      return argv[0] === "apply" ? refuse("apply goes through a pull request") : run();
    }),
    tool.shim.config({ REGION: "iad" }),
  ],
}).sh`terraform plan && inngest-tool config REGION`;
```

`shims` is accepted by `commands.run()` and `$` and takes only `tool.shim()` values. Code in the sandbox reads settings with `inngest-tool config NAME` and lists the shims with `inngest-tool shims`. Commands with tools or shims can now run longer than five minutes, `exitCodes` works with them, and a timeout fails as a `sandbox_exec_timed_out` error. Shims use a small static `inngest-tool` binary that the SDK puts into the sandbox when it is missing.
