---
"@inngest/ci": minor
---

A job can now start from a job another app defines with `image.job()`. That app builds it once for every app that asks.

```ts
import { image } from "@inngest/ci";

ci.job({ id: "test", from: image.job("platform/node-base") }, async () => {
  await $`pnpm test`;
});
```
