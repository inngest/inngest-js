---
"inngest": patch
---

Sandbox handles in `inngest/experimental` have a `$` that runs a command as one step:

```ts
await group.sandbox("box", async (sb) => {
  await sb.$.sh`pnpm install`;
  const sha = await sb.$`/usr/bin/git rev-parse HEAD`.text();
  await sb.$({ cwd: "/work", timeout: "20m" }).sh`pnpm test`;
});
```

A non-zero exit throws. Pass `exitCodes` to allow others. `getCommandError(err)` reads the command, exit code and output tails from a failed command, which reaches your handler as a `StepError`.

`commands.run` also takes `exitCodes`. A `timeout` over five minutes now runs the command as a process that the steps follow.
