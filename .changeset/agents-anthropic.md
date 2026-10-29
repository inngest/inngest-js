---
"inngest": minor
---

`inngest/experimental/agents` now ships one model adapter, for Anthropic. `anthropic({ model, client })` (also `agent.anthropic()`) returns the `model` for `agent.loop()` or a loop of your own, and calls the Messages API with `@anthropic-ai/sdk`, an optional peer dependency. Pass your client, or leave `client` out and the SDK is imported on first use.

```ts
const claude = agent.anthropic({
  model: "claude-sonnet-5-5",
  client: new Anthropic(),
  cache: { ttl: "1h" },
});

await agent.loop({ model: claude, prompt, tools, context: false, price: anthropicPrices });
```

- **Prompt caching:** breakpoints go on the system prompt (which caches the tools with it), the end of the conversation and where the previous call's conversation ended, so each call reads what the one before wrote. `cache.ttl` is `"5m"` or `"1h"`, and `false` turns it off. Pass `context: false` to `agent.loop()` so its old-result shortening does not change the cached prefix.
- **Usage and cost:** `AgentUsage` gains `cacheRead`, `cacheWrite` and `cacheWrite1h` (`input` includes them), model steps write `agent.cache_read_tokens` and `agent.cache_write_tokens` scores, and a `price` table can set `cacheRead`, `cacheWrite` and `cacheWrite1h` rates. `anthropicPrices` is a default table for the current Claude models; spread it to override.
- **Errors:** a 400, 401, 403 or 404, a refusal, and a reply cut off by `maxTokens` fail the step for good; 429, 529 and 5xx are retried, after the `retry-after` the API sent.

`agent.loop()` also no longer needs `tools`, and a second loop with the same `id` in one run now gets `-2`, `-3` after it instead of repeating step IDs. A run in flight that already ran a second loop with the same `id` will find its step IDs changed on replay; give such loops an explicit `id` before upgrading.
