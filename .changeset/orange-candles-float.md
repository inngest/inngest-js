---
"inngest": minor
---

Adds the ability to configure the number of `bufferedSteps` and `maxInterval` when checkpointing.

```ts
import { inngest } from "./client";

export const helloWorld = inngest.createFunction(
  { id: "hello-world", checkpointing: { bufferedSteps: Infinity, maxInterval: "5s" } },
  { event: "demo/event.sent" },
  async ({ event, step }) => {
    const a = await step.run("a", () => "a");
    const b = await step.run("b", () => "b");
    const c = await step.run("c", () => "c");

    return {
      message: `Hello ${event.name}! ${a} ${b} ${c}`,
    };
  },
);
```

If `checkpointing: true` is used, `bufferedSteps` defaults to `1` and no `maxInterval` is set.
