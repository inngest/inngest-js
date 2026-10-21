---
"inngest": minor
---

`agent.anthropic()` and `agent.openai()` now turn your own SDK client into a model for `agent.loop()`. Options such as `model` and `max_tokens` are typed by your SDK, so Inngest needs no model list and installs no vendor package. Tools can also declare an `effect`, and `agent.loop({ dryRun: true })` (or `dryRun(tools)` for sandbox tools) runs only the reads and answers every other tool with what it would have done.

```ts
const claude = agent.anthropic(new Anthropic(), {
  model: "claude-sonnet-5-5",
  max_tokens: 8192,
});

const refund = tool.step({
  input: z.object({ id: z.string() }),
  effect: "write",
  run: ({ id }) => stripe.refunds.create({ order: id }),
});

await agent.loop({ model: claude, prompt, tools: { refund }, dryRun: true });
```
