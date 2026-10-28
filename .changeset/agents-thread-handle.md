---
"inngest": minor
---

`inngest/experimental/agents` thread handles now report `state()` as `{ status, turn, summary, usage, keys }`, work from inside other functions (messages are steps), and can ask another thread with `handle.request(payload)`, which the thread answers with `message.reply(data)`. `agent.threads.list()` (experimental, not yet verified against Inngest Cloud) lists an agent's threads through Insights.

```ts
const { status, usage } = await bot.thread("C0123/1712.44").state();
const reply = await worker.thread("w1").request({ n: 21 }, { timeout: "10m" });
```
