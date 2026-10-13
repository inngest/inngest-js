---
"inngest": minor
---

Sandbox durations (`runningTimeout`, `timeout`) now accept compound strings like `"1h30m"` and `Temporal.Duration` values, and are no longer capped at 5 minutes by the SDK. The new `durationToMs()` export turns any of these into milliseconds.

```ts
await step.sandbox.create("build", { runningTimeout: "1h30m" });
```
