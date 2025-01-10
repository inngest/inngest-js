---
"inngest": patch
---

Fix named functions returning `never[]` for their parameters when passed to `step.run()`

```ts
// This now works
step.run("", function named() {});
```
