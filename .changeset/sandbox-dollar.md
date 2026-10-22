---
"inngest": patch
---

Sandbox handles have a `$` for running commands as one step each:

```ts
await group.sandbox("box", async (sb) => {
  await sb.$`pnpm install`;
  const sha = await sb.$`git rev-parse HEAD`.text();
  await sb.$({ cwd: "/work", timeout: "20m" })`pnpm test`;
});
```

A non-zero exit throws, and `getCommandError(err)` reads the command, exit code and output tails from it. Pass `exitCodes` to allow others, and use `sb.$.sh` for shell scripts. `commands.run` also takes `exitCodes`, and a `timeout` over five minutes now runs as a process that the steps follow.
