---
"@inngest/ci": minor
---

You can now force a cached job to rebuild by sending an invalidate event. It deletes the job's cached snapshots in every scope, or in one with `scope`. Running sandboxes are unaffected.

```ts
await inngest.send(invalidateEvent("node-base"));
```
