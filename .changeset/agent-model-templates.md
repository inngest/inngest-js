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

`step.sandbox.lazy()` gives a sandbox that is only created when something first uses it, so a run that never needs one pays nothing.

```ts
await using sandbox = step.sandbox.lazy("coder", { name, vcpu: 2, memoryMb: 2048 });

await agent.loop({ model: claude, prompt, tools: sandbox.tools.code() });
```
