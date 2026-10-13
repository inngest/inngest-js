---
"@inngest/ci": minor
---

Jobs can now start from a sandbox snapshot you captured under a name, per job or for every job.

```ts
ci.job({ id: "test", from: image.snapshot("agent-deps") }, …);

createCi(inngest, { from: image.snapshot("agent-deps") });
```
