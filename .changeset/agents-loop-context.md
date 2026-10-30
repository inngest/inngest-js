---
"inngest": minor
---

Experimental agents: `agent.loop()` now sends the whole conversation on every call and never edits old messages. The `context` option, which shortened old tool results past 200,000 characters, is removed: it changed the cached prefix on every call after that and rewrote history that preserved thinking forbids editing. `maxToolOutput` now defaults to 100000 characters (it was 8000).

Two opt-ins replace it:

```ts
await agent.loop({
  model: claude,
  prompt,
  tools: sandbox.tools.code(),
  // Summarise the start of the conversation only when it nears the model's limit.
  compaction: { maxTokens: 700_000, keep: 8 },
  // Save a result longer than maxToolOutput to a sandbox file instead of losing it.
  spill: { sandbox },
});
```

- **`compaction`:** past `maxTokens` (estimated, about three characters a token), everything but the last `keep` messages (default 8) is summarised by the loop's own `model` into one message, or by your `summarise` function. The summary is made once, stored in that model step's output so a replay restores it, and reused until the budget is passed again. The `history` of the result is never summarised, and the summary call's tokens are counted in the turn's `usage`. An empty summary is ignored. The estimate counts messages only, so leave headroom for the system prompt and tools. A follow-up `agent.loop({ history })` starts without the summary and makes a new one if it needs it. Off by default.
- **`spill`:** a tool result longer than `maxToolOutput` is written whole to `dir` (default `/tmp`, which must exist) in the sandbox, in a file named by a hash of its content, and the model is told the path after the clipped text. If the write fails, the model is told that instead and the run goes on.
