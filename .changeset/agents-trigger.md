---
"inngest": minor
---

The body of an agent in `inngest/experimental/agents` gets `trigger`: the event of `on` that started the run, flat (`id`, `name`, `data`) and typed from `on`, so narrowing by `name` types `data` with no casts and no reaching into `event.data.event`. For a cron it is the tick (`{ cron }`), for `invoke()` the caller's input (without what the SDK adds for the invoked agent). It is `undefined` when a plain thread message started the run (`thread.send()`, a reply in a thread).

```ts
agents.agent(
  { id: "orders", on: [{ event: order, thread: "event.data.id" }, { cron: "0 9 * * *" }] },
  async ({ trigger }) => {
    if (trigger?.name === "shop/order.created") {
      // trigger.data.total is a number
    }
  },
);
```
