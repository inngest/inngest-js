# Inngest Realtime

Typed, declarative realtime channels and topics built into the core Inngest SDK. Publish from functions, subscribe from anywhere.

## Quick start

```ts
import { realtime } from "inngest";
import { z } from "zod";

// 1. Declare a channel with typed topics
const agentChat = realtime.channel({
  name: ({ threadId }: { threadId: string }) => `agent-chat:${threadId}`,
  topics: {
    status: { schema: z.object({ message: z.string(), step: z.string().optional() }) },
    tokens: { schema: z.object({ token: z.string() }) },
  },
});

// 2. Publish from an Inngest function
const aiChat = inngest.createFunction(
  { id: "ai-chat" },
  { event: "ai/chat.requested" },
  async ({ event, step, publish }) => {
    const chat = agentChat({ threadId: event.data.threadId });

    await publish(chat.status, { message: "Thinking..." });

    const response = await step.run("generate", async () => {
      return llm.generate(event.data.prompt);
    });

    for (const token of response.tokens) {
      await publish(chat.tokens, { token });
    }

    // Durable publish — memoized, won't re-fire on retry
    await step.realtime.publish("done", chat.status, { message: "Done" });
  },
);

// 3. Subscribe server-side
for await (const msg of inngest.realtime.subscribe({
  channel: agentChat({ threadId: "thread_abc" }),
  topics: ["status", "tokens"],
})) {
  console.log(msg.topic, msg.data);
}
```

## Channels

Channels are the addressing primitive for realtime data. A channel is a user-defined string namespace that can represent runs, users, threads, or anything else.

### Static channels

When the channel name is fixed, pass a string:

```ts
const systemAlerts = realtime.channel({
  name: "system:alerts",
  topics: {
    alert: {
      schema: z.object({
        level: z.enum(["info", "warn", "error"]),
        message: z.string(),
      }),
    },
  },
});

// Use directly — no instantiation needed
systemAlerts.name;           // "system:alerts"
systemAlerts.alert;          // TopicRef for "system:alerts" / "alert"
```

### Parameterized channels

When each channel instance represents a different entity, pass a function:

```ts
const agentChat = realtime.channel({
  name: ({ threadId }: { threadId: string }) => `agent-chat:${threadId}`,
  topics: {
    status: { schema: z.object({ message: z.string() }) },
    tokens: { schema: z.object({ token: z.string() }) },
  },
});

// Call with params to get a concrete instance
const chat = agentChat({ threadId: "thread_abc" });
chat.name;                   // "agent-chat:thread_abc"
chat.status;                 // TopicRef for "agent-chat:thread_abc" / "status"
chat.tokens;                 // TopicRef for "agent-chat:thread_abc" / "tokens"
```

### Topic accessors

Every topic defined on a channel becomes a dot-access property on channel instances. These **topic accessors** return lightweight `TopicRef` objects that carry the resolved channel name, topic name, and topic config. They're used as the first argument to `publish`:

```ts
const ref = chat.status;
// { channel: "agent-chat:thread_abc", topic: "status", config: { schema: ... } }
```

## Topics

Topics are typed categories within a channel. Each topic defines the shape of one category of message.

### Schema-validated topics

Use `schema` with any [Standard Schema](https://github.com/standard-schema/standard-schema) compatible validator (Zod, Valibot, ArkType, etc.). Data is validated at publish time:

```ts
const ch = realtime.channel({
  name: "pipeline",
  topics: {
    status: {
      schema: z.object({
        message: z.string(),
        step: z.string().optional(),
      }),
    },
  },
});
```

### Type-only topics

When you only need TypeScript types without runtime validation (zero bundle cost), use `staticSchema<T>()`:

```ts
import { realtime, staticSchema } from "inngest";

const ch = realtime.channel({
  name: "pipeline",
  topics: {
    usage: {
      schema: staticSchema<{
        inputTokens: number;
        outputTokens: number;
        model: string;
      }>(),
    },
  },
});
```

### Mixing both

Schema and type-only topics can coexist on the same channel:

```ts
import { realtime, staticSchema } from "inngest";

const contentPipeline = realtime.channel({
  name: ({ runId }: { runId: string }) => `pipeline:${runId}`,
  topics: {
    status: { schema: z.object({ message: z.string() }) },
    tokens: { schema: z.object({ token: z.string() }) },
    usage: { schema: staticSchema<{ inputTokens: number; outputTokens: number }>() },
  },
});
```

## Type inference

### Infer topic data types

```ts
// Extract the payload type of a topic
type StatusPayload = typeof agentChat.$infer["status"];
// { message: string }

// Extract channel params
type ChatParams = typeof agentChat.$params;
// { threadId: string }
```

## Publishing

All publish functions take two arguments: a **topic accessor** (where) and **data** (what). The data argument is type-checked against the topic's schema or type definition.

### `publish(ref, data)` — non-durable, in function context

Available on the function context. Executes immediately, **not** memoized. Re-fires on retry. Best for high-frequency streaming where duplicates are harmless:

```ts
async ({ publish }) => {
  const chat = agentChat({ threadId });
  await publish(chat.tokens, { token: "Hello" });
};
```

### `step.realtime.publish(id, ref, data)` — durable

A durable step that participates in memoization. Won't re-fire on retry. Best for important state transitions where duplicates matter:

```ts
async ({ step }) => {
  const chat = agentChat({ threadId });
  await step.realtime.publish("final-status", chat.status, {
    message: "Complete",
  });
};
```

### `inngest.realtime.publish(ref, data)` — non-durable, outside functions

Publish from anywhere (API routes, webhooks, background jobs) using the Inngest client directly:

```ts
await inngest.realtime.publish(
  agentChat({ threadId: "thread_abc" }).status,
  { message: "Externally triggered update" },
);
```

### When to use which

| | `publish(ref, data)` | `step.realtime.publish(id, ref, data)` | `inngest.realtime.publish(ref, data)` |
|---|---|---|---|
| Durable / memoized | No | Yes | No |
| Re-fires on retry | Yes | No | N/A |
| Requires step ID | No | Yes | No |
| Available in | Function context | Function context | Anywhere |
| Best for | Token streaming, progress ticks | State transitions, final results | External publishing |

## Subscribing

### Server-side async iterator

```ts
for await (const msg of inngest.realtime.subscribe({
  channel: agentChat({ threadId }),
  topics: ["status", "tokens"],
})) {
  if (msg.topic === "status") {
    console.log(msg.data.message); // typed
  }
}
```

### Subscription tokens

Mint scoped tokens server-side for client subscriptions:

```ts
// Server route
export async function POST(req: Request) {
  const { threadId } = await req.json();

  const token = await inngest.realtime.token({
    channel: agentChat({ threadId }),
    topics: ["status", "tokens"],
  });

  return Response.json({ token });
}
```

## Import paths

```ts
// From the main package
import { realtime, staticSchema } from "inngest";

// Or from the dedicated subpath
import { realtime, channel } from "inngest/realtime";
```
