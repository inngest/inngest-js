---
"inngest": patch
---

An agent can let its model listen for events while it works. Set `inboxTools` on the agent with the sources it may use (each fixed to a `thread` expression, so the model cannot hear another thread; its own `if` can only narrow), then pass the body's `inboxTools` to `agent.loop()`: the model calls `inbox_listen` to start listening in the background, carries on, and is told when something arrives at its next model call (set `foldMessages: "all"`), or waits with `inbox_wait` or reads with `inbox_read`, and stops with `inbox_stop`. `maxListeners`, `maxPerRun` and `maxWait` cap the cost, and a source that is not listed is a tool error naming the allowed ones. Pass the same tools to `sandbox.tools.code({ tools: inboxTools })` and `run_code` scripts use the same inbox, where `inbox_wait` suspends the script instead of holding a command open. Messages come back marked with `agent.untrusted()`. The tools read through views of the listened events, so they never take a stop, a user message or a request from the loop.

```ts
agents.agent({
  id: "earl",
  foldMessages: "all",
  inboxTools: {
    listen: [{ event: "github/check_run", thread: "event.data.thread" }],
    maxWait: "30m",
  },
}, async ({ inbox, control, inboxTools }) => {
  await agent.loop({ model, prompt, tools: { ...inboxTools }, ...control });
});
```
