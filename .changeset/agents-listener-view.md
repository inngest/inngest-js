---
"inngest": minor
---

`inbox.listen()` now returns the scoped view of its event, the same as `inbox.of(event)` (`next({ timeout })`, `current()`, `unread()`, `for await`, typed by the event type) plus `stop()` and `await using`. The main inbox still receives the events. `ThreadListener` is generic over the event, so code that names it needs no change.

```ts
await using deploys = await inbox.listen("deploy/finished", { if: `async.data.service == "api"` });
const done = await deploys.next({ timeout: "30m" });
```

`agent.anthropic()` covers one-off calls and per-call settings without a wrapper. `claude.with({ model, effort, maxTokens, thinking, cache, volatile, params })` is the same model with other options, for a loop or a call. Calling the model directly inside a `step.run` makes a single reply: `claude({ system, prompt, tools, toolChoice })`, where `toolChoice` is `"none"` or `{ name }` (asked for in words, since the newest models refuse a forced `tool_choice`). `output` takes a Zod 4 (or Standard JSON Schema) schema and returns the reply validated and typed as `output`:

```ts
const { output } = await step.run("triage", async () => {
  return claude.with({ maxTokens: 2000 })({
    system: "Triage the ticket.",
    prompt: ticket,
    output: z.object({ investigate: z.boolean(), reason: z.string() }),
  });
});
```

Keep the loop's `system` string stable: it starts the cached prefix. Put what changes between calls in the adapter's `volatile` option. Changing `model`, `effort`, `thinking` or `cache` for a call changes the cached prefix too.

`inngest/experimental/agents` also exports `ThreadListener`, `InboxSource`, `InboxListenOptions`, `TriggerEvent`, `View` and `EventMessage`, so every type of an `AgentTypes` bag and an `AgentBodyContext` can be named.
