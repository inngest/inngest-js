---
"inngest": minor
---

`inngest/experimental` can now run an agent as a long conversation. `step.subscribe()` is a durable inbox that delivers each message as its own step, thread handles `send`, `steer`, `stop` and read `state()` for a conversation that spans runs, and `kv` stores values per run, thread, session, function, app or environment in Redis (`INNGEST_EXPERIMENTAL_KV_URL`).

```ts
for await (const message of inbox) {
  await agent.loop({ model, prompt: message.data.content, tools, ...control });
}
```
