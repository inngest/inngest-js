---
"inngest": patch
---

Experimental: command shims for Sandboxes. `tool.shim()` makes a program on the command's `PATH` call a handler in your app first. The handler runs the real program (as called, or with another `argv`, extra `env` or `stdin`), replies with an exit code and output, or refuses:

```ts
import { tool } from "inngest/experimental";

await sandbox.$({
  shims: [
    tool.shim("terraform", ({ argv, run, refuse }) => {
      return argv[0] === "apply" ? refuse("apply goes through a pull request") : run();
    }),
    tool.shim.injectEnv("fly", { FLY_API_TOKEN: () => mintDeployToken(app) }),
    tool.shim.gitCredentials({
      "github.com": async ({ path }) => ({ username: "x-access-token", password: await installationToken(path) }),
    }),
    tool.shim.hostEnv({ REGION: "iad" }),
  ],
}).sh`terraform plan && fly deploy && git push origin HEAD`;
```

`shims` is accepted by `commands.run()` and `$` and takes only `tool.shim()` values. Minted values are never stored in the run. Code in the sandbox reads `inngest-tool env NAME` and lists the shims with `inngest-tool shims`. Commands with tools or shims can now run longer than five minutes, `exitCodes` works with them, and a timeout fails as a `sandbox_exec_timed_out` error. Shims that have a handler use a small static `inngest-tool` binary that the SDK puts into the sandbox when it is missing.
