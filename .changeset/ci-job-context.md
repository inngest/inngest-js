---
"@inngest/ci": minor
---

Job and matrix handlers now get one context object, and a job's cache key parts are readable from it, including by the jobs that start from it, even in another app.

```ts
const base = ci.job(
  {
    id: "base",
    cache: { key: { deps: files("pnpm-lock.yaml"), devServer: latestDevServer } },
  },
  async ({ key }) => {
    await $`pnpm install --dev-server ${key.devServer}`;
  },
);

const test = ci.job({ id: "test", from: base }, async ({ from }) => {
  from.key.devServer;
});
```

Breaking: a matrix handler reads its combination from `matrix`, and a job handler reads its input from `input`.

```ts
ci.matrix({ id: "compat", axes: { node: ["20", "22"] } }, async ({ matrix }) => {
  await $`fnm use ${matrix.node}`;
});

ci.job({ id: "build", input: schema }, async ({ input }) => {});
```

A cache key can now mix `files()` with async functions, and a function in it is called once per run.
