---
"inngest": minor
---

You can now build a coding agent from three building blocks in `inngest/experimental/agents`. `agent.loop()` runs any model with tools, one durable step per model call and per tool call; `sandbox.tools.code()` gives it read, write, edit, search and run; and `repo(sandbox, { repo })` checks out a repository and pushes branches without the token ever entering the sandbox.

```ts
const { text } = await agent.loop({
  model: claude,
  prompt: `Task: ${event.data.task}`,
  tools: sandbox.tools.code(),
});
```

`AgentLoopResult.stopped` is `"done" | "maxTurns" | "stopped" | "budget"`. `"budget"` is new, so a `switch` over `stopped` that has no default needs a case for it. The loop stops with it when an agent's `limits.budget` is spent, but only when the body passes `control` to `agent.loop()`.

`inngest/experimental` also gains the snapshot cache that @inngest/ci builds on: `snapshotCache()` with the `replace` option, the `SnapshotCacheAction` passed to its `memo` (`"find" | "name-taken" | "replaced"`), and `SnapshotKeyEntry` for `snapshotKey()` parts.
