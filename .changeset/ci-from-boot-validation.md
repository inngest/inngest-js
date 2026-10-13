---
"@inngest/ci": patch
---

Mistakes in a job's `from` now fail when your app boots, with a message naming the problem, instead of partway through a run. This covers a parent from another CI client, a value that isn't a job, input that doesn't match the parent's schema, and `from` cycles (which used to build forever).

```ts
ci.job({ id: "test", from: notAJob }, …); // throws at boot
```
