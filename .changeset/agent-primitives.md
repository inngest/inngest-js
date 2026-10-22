---
"inngest": minor
---

You can now build a coding agent from three building blocks in `inngest/experimental`. `agent.loop()` runs any model with tools, one durable step per model call and per tool call; `sandbox.tools.code()` gives it read, write, edit, search and run; and `repo(sandbox, { repo })` checks out a repository and pushes branches without the token ever entering the sandbox.

```ts
const { text } = await agent.loop({
  model: claude,
  prompt: `Task: ${event.data.task}`,
  tools: sandbox.tools.code(),
});
```
