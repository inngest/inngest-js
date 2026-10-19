---
"@inngest/ci": minor
---

Jobs can now return an output: an object of JSON values and commands. Jobs that start `from` them read the data as `from.output` and run the commands as `from.$.x`, all typed, merged up the chain with the nearest job winning a name. A cached job gives the same output every time it is reused.

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

`from.ancestry[i].output` and `from.ancestry[i].$` give each job's own output, and `job.with(input)` keeps the output types. An uncached job's call resolves to its data; a cached job's call resolves to nothing. Jobs that start `from` another now get their machine before the handler runs.
