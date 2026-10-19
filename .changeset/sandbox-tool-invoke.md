---
"inngest": patch
---

Experimental: an Inngest function, or a `referenceFunction()` to one, can now be a sandbox tool. The code calls it with named arguments, which become the event data, and gets the function's result back. The invoke is a durable step.

```ts
import { eventType } from "inngest";

const refund = inngest.createFunction(
  {
    id: "refund",
    triggers: [
      eventType("order/refund", { schema: z.object({ orderId: z.string() }) }),
    ],
  },
  async ({ event }) => issueRefund(event.data.orderId),
);

await sandbox.commands.run("agent", "node agent.js", {
  tools: { refund },
});
```

The arguments are checked against the function's trigger schema when it has one. Without a schema, any named arguments are sent; wrap the invoke in `tool.group()` to declare the input you want.
