---
"inngest": minor
---

Sandbox durations now accept compound strings like `"1h30m"` and `Temporal.Duration` values.

```ts
await step.sandbox.create("build", { runningTimeout: "1h30m" });
```
