---
"inngest": minor
---

`ThreadMessage` in `inngest/experimental/agents` is a union by `kind`: a `"request"` has `payload` and `replyTo`, a `"stop"` has `when`, a `"steer"` has `content`, and a `"user"` has neither. Narrow with `message.data.kind`; `content` stays readable on every kind. An agent can declare `requests: { request, reply }` (schemas, or `staticSchema()` for types only) to type the payload of a `"request"` message, `message.reply()`, and `request()` on the handle from `agent.thread()`. That handle checks the payload against `request`, and `reply()` checks its data against `reply`. Without `requests` both stay `unknown`, and `request<TAnswer>()` still names the reply you expect. `ThreadHandle`, `ThreadInbox`, `ThreadInboxMessage`, `AgentBody`, `AgentBodyContext` and `AgentFunction` gain generics for the two types, and `getThread()` takes them too.

```ts
const reviewer = agents.agent(
  {
    id: "reviewer",
    on: { event: "review/asked", thread: "event.data.id" },
    requests: {
      request: z.object({ question: z.string() }),
      reply: z.object({ answer: z.string() }),
    },
  },
  async ({ inbox }) => {
    for await (const message of inbox) {
      if (message.data.kind === "request") {
        await message.reply({ answer: message.data.payload.question });
      }
    }
  },
);

const { answer } = (await reviewer.thread("t1").request({ question: "ok?" })) ?? {};
```
