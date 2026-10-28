---
"inngest": minor
---

Agents in `inngest/experimental/agents` work with `eventType()` and every trigger a function takes. `on` accepts an event name, an `eventType()` (alone or as `event`, which also types and validates the event and types `message`), `{ cron }` and `invoke()`. A cron starts one thread per agent by default (the agent's ID); set `thread` on the cron for another. A tick or an invoke without `data.thread` while that thread's run is live is skipped. The agent's own events cannot be used as triggers. `step.subscribe()` takes `eventType()`s and infers the message data. The agent's own events (`agent/message`, `agent/skills.bake`) are exported as event types (`agentMessage`, `skillsBake`).

```ts
const order = eventType("shop/order.created", { schema: z.object({ id: z.string() }) });

agents.agent(
  {
    id: "orders",
    on: [
      { event: order, thread: "event.data.id", message: (e) => `order ${e.data.id}` },
      { cron: "0 9 * * *" },
    ],
  },
  async ({ inbox }) => {
    // ...
  },
);
```
