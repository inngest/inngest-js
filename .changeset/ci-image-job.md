---
"@inngest/ci": minor
---

Jobs can now start from a job another app defines. That app builds it once for everyone who asks.

```ts
ci.job({ id: "test", from: image.job("base-app/node-base") }, …);
```
