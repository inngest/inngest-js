---
"inngest": minor
---

Agents in `inngest/experimental/agents` score themselves, so you can see in Insights where a thread is slow or goes wrong. It is on by default and adds no steps: each score is written with the result of a step that already runs, and never again on a replay. A model step gets `agent.model_ms`, `agent.input_tokens`, `agent.output_tokens`, `agent.tool_calls` and `agent.steers`; a tool step gets `agent.tool_ms` and `agent.tool_error`; a `report()` post gets `agent.first_output_ms` for the first one (from the trigger event) and `agent.output_gap_ms` for the ones after; and a stop request gets `agent.stopped`. Turn them off with `scores: false` in the agent config or on `agent.loop()`. Add your own, with any name, from the body or from inside a tool with `scores.score(name, value)`, where `scores` is a field of the body's argument.

```ts
agents.agent({ id: "support" }, async ({ inbox, control, scores }) => {
  const message = await inbox.next();

  const escalate = tool.step({
    description: "Hands the thread to a person",
    input: z.object({}),
    run: async () => {
      await scores.score("support.escalated", true);

      return "escalated";
    },
  });

  await agent.loop({
    model,
    prompt: message?.data.content ?? "",
    tools: { escalate },
    ...control,
  });
});
```
