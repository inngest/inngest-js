---
"inngest": minor
---

Agents in `inngest/experimental/agents` work with `eventType()` and every trigger a function takes. `on` accepts an event name, an `eventType()` (alone or as `event`, which also types and validates the event and types `message`), `{ cron }` and `invoke()`. A cron starts one thread per agent by default (the agent's ID); set `thread` on the cron for another. A tick or an invoke that does not come from `agent.invoke()` while that thread's run is live is skipped. The agent's own events and the plain name `inngest/function.invoked` (use `invoke(schema)`) cannot be used as triggers. `step.subscribe()` takes `eventType()`s in `event` and `events` and infers the message data from them; it has a second generic, `TOpts`, after `TData` (an explicit `TData`, including `any`, still wins), and `SubscribeOptions.events` is now `readonly`. The agent's own events (`agent/message`, `agent/skills.bake`) are exported as event types (`agentMessage`, `skillsBake`).

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
