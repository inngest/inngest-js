---
"@inngest/ci": minor
---

A cache key can now mix `files()` with async functions, so a job's cache can depend on a value you look up when it runs.

```ts
ci.job(
  {
    id: "base",
    cache: { key: [files("pnpm-lock.yaml"), async () => latestRelease()] },
  },
  async () => {
    await $`pnpm install`;
  },
);
```
