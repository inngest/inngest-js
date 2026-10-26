---
"inngest": minor
---

Added `step.memo()`, which saves a value so it never changes, even when your function runs again with a different one. It returns what `step.run()` would return, but doesn't stop your function to do it.

```ts
const startedAt = await step.memo("started-at", Date.now());
```
