---
"@inngest/ci": minor
---

You can now define jobs inside a pipeline, and start other jobs `from` them. They build in the run that defined them, and cached ones are still reused by later runs.

```ts
ci.pipeline({ id: "pr", on }, async () => {
  const base = ci.job("base", async () => {
    await $`pnpm install`;
  });

  const lint = ci.job({ id: "lint", from: base }, async () => {
    await $`pnpm lint`;
  });

  await lint();
});
```

Defining the same job ID twice in one run now throws a `CiUsageError`.
