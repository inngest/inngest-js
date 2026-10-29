---
"inngest": patch
---

An agent's `limits.budget` can now stop a thread by cost: `budget: { usd: 5 }`. The SDK knows no prices, so you give them in `limits.price`, a function of each model call's tokens and model that returns dollars, or a table of rates per million tokens by model name. The loop adds the cost of each call to `usage.usd` (and to each turn's `usage.usd`, and the thread's `state().usage.usd`), and stops with `stopped: "budget"` once the dollars are spent, like the token budget. Have your `model` function return the model's name as `model` in its reply so a price can depend on it. A sub-agent gets what is left, and needs its own `limits.price` to count against it.

```ts
agents.agent({
  id: "researcher",
  limits: {
    budget: { usd: 2 },
    price: { "claude-sonnet-5-5": { input: 3, output: 15 }, "*": { input: 5, output: 25 } },
  },
}, async ({ control }) => {
  await agent.loop({ model, prompt, tools, ...control });
});
```
