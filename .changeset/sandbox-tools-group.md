---
"inngest": minor
---

Experimental: sandbox code can now call `tool.group()` tools, whose body is a group of real steps. Run steps in parallel, invoke other functions and get their result, send events, or wait for one, all from a single tool call.

```ts
import { step } from "inngest";
import { tool } from "inngest/experimental";

const refund = tool.group({
  input: z.object({ orderId: z.string() }),
  run: async ({ orderId }) => {
    const result = await step.invoke("refund", { function: refundFn, data: { orderId } });
    await step.sendEvent("notify", { name: "order/refunded", data: result });

    return result;
  },
});
```
