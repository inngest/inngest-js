---
"inngest": minor
---

`ThreadMessage` in `inngest/experimental/agents` is a union by `kind`: a `"request"` has `payload` and `replyTo`, a `"stop"` has `when`, a `"steer"` has `content`, and a `"user"` has neither. **Breaking for types:** reading `.payload`, `.replyTo` or `.when` on a message you have not narrowed stops compiling; narrow on `message.data.kind` first. `content` stays readable on every kind.

An agent can declare `requests: { request, reply }` (schemas, or `staticSchema()` for types only). They type the payload of a `"request"` message, `message.reply()`, and `request()` on the handle from `agent.thread()`. A schema must accept the value it outputs, so one that transforms its input (`.transform()`, `z.coerce`) is a type error. Schemas may validate asynchronously. The handle checks its payload against `request` before sending, `reply()` checks its data against `reply`, and a request that breaks `request` when it reaches the agent, from any sender, is dropped with a warning and never delivered to your code (the asker's wait times out). Without `requests` both types stay `unknown`, and `request<TAnswer>()` still names the reply you expect. `ThreadHandle`, `ThreadInbox`, `ThreadInboxMessage`, `AgentBody`, `AgentBodyContext` and `AgentFunction` gain generics for the two types, and `getThread()` takes them too.

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
