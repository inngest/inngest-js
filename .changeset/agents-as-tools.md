---
"inngest": minor
---

An agent can now go straight into `tools`, in `agent.loop()` and anywhere else tools are accepted. The model calls it by the key you gave it, the call starts the agent and waits for its result as `agent.invoke()` does, and the result is typed from the agent's return. There is no stub tool to write.

```ts
await agent.loop({ model, prompt, tools: { researcher, coder } });
```

- **Input:** `{ message: string }`, which a plain agent reads as an `agent/message` event with `data.text`, the same as `thread.send()`, so it needs no `on: invoke(...)`. An agent with `on: invoke(schema)` takes that schema's data instead.
- **Description:** the agent's `description` is what the model reads, with a fallback naming the agent.
- **Lists:** `agentTools([researcher, coder])` names agents by their ID with every character a tool name cannot hold replaced by `_`.
- **Limits:** `depth`, `spawn` and `budget` apply as before. An agent in `tools` is allowed by being listed, so `limits.mayCall` now only limits calls made with `agent.invoke()`.
