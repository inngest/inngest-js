---
"inngest": minor
---

The events of an agent's `on` type the rest of the agent: the handler's `event.data.event`, every `inbox` message's `data.event` (a union with a `name` to narrow on, a cron tick included) and the `sandboxes` config function. An event that breaks its `eventType()` schema is dropped from the inbox of a live run and acked, as core rejects it for a run it would start. `agent.invoke(agent, input)` takes the agent itself: the input is the data of its `invoke()` trigger and the result is what its body returns; a string target stays untyped. The callee of `agent.invoke()` runs on the thread the call names, so parallel calls to one agent each get a run; a `data.thread` set by hand on an invoke is no longer read.

```ts
const asked = invoke(z.object({ question: z.string() }));

const researcher = agents.agent({ id: "researcher", on: asked }, async ({ event }) => {
  return { answer: `about ${event.data.event?.data.question}` };
});

const { answer } = await agent.invoke(researcher, { question: "why" });
```
