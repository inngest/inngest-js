---
"inngest": minor
---

Every item in an agent's inbox is now a plain event: `{ id, name, data, ts, seq }`, typed by its schema, so `switch (message.name)` narrows `data`. The `kind` and `content` fields are gone, and so is the trigger `message` option (and `message` on inbox sources and the Slack and GitHub triggers).

The agent's own messages are named events: `thread.send(text)` sends `agent/message` with `data.text`, `thread.steer(text)` sends `agent/steer`, `thread.stop()` sends `agent/stop`, and `thread.request()` sends `agent/request` with `data.payload`, `data.replyTo` and `data.from`. `message.reply()` exists on `agent/request` messages only.

```ts
for await (const message of inbox) {
  switch (message.name) {
    case "agent/message":
      await agent.loop({ model, prompt: message });
      break;
    case "agent/request":
      await message.reply({ ok: true });
      break;
  }
}
```

What the model sees moves to `agent.loop()`: `prompt` and `steer` take text, content blocks or an event, and the new `format(event)` words an event as text or content blocks. By default the model sees `data.text` for `agent/message` and `agent/steer`, and the event's name and data as JSON for anything else. `control.steer()` returns events, and `AgentMessage` user content can be content blocks.
