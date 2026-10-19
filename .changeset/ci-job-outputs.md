---
"@inngest/ci": minor
---

Jobs can now return an output: JSON values and commands. Jobs that start from them read the data as `from.output` and run the commands with `from.$`, typed, and a cached job gives the same output without running again.

```ts
const base = ci.job({ id: "base", cache: { key: files("pnpm-lock.yaml") } }, async () => {
  await $`pnpm install`;

  return { version: await $`pnpm --version`.text(), devServer: $`pnpm dev` };
});

const test = ci.job({ id: "test", from: base }, async ({ from }) => {
  from.output.version;

  await from.$.devServer.background();
});
```
