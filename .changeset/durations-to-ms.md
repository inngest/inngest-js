---
"inngest": minor
---

Sandbox durations now accept compound strings like `"4m30s"`.

```ts
await step.sandbox.create("build", {
  name: "build",
  vcpu: 2,
  memoryMb: 2048,
  runningTimeout: "4m30s",
});
```
