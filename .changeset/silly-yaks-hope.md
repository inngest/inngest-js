---
"inngest": minor
---

Add ability for signal waits to supersede others

```ts
await step.waitForSignal("step-id", {
  signal: "my-signal",
  timeout: "5m",
  onConflict: "replace",
});
```
