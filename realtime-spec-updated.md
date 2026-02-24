# Realtime SDK DX Improvements [Draft]

Status: Not started
Author: Jacob
Created At: February 12, 2026 9:35 AM
Last Edited: February 24, 2026 12:06 PM

## Context / goals

This spec defines a new Realtime SDK experience inside the core inngest JS/TS SDK (deprecating `@inngest/realtime`) that makes it easy to:

- Trigger an Inngest function run and subscribe to typed updates from that run.
- Build realtime UIs (React-first) without thinking about connections, chunking, parsing, or lifecycle.
- Support both product UI status updates and AI streaming (tokens, tool calls, structured outputs) via thin adapters.

## Design priorities

- **Developer ergonomics first:** minimal boilerplate, great autocomplete, reasonable defaults.
- **Simple, self-describing APIs:** the happy path should be obvious from autocomplete/types alone.
- **Declarative realtime use cases:** declare the shape of your channels and topics once, then subscribe by what you want.
- **E2E typing:** shared types/validation between publisher (function) and subscriber (UI/server).
- **Ecosystem fit:** feels idiomatic in modern JS/TS (React 18+, Next, TanStack), and integrates cleanly with AI libraries via adapters.
- **Extensibility:** the addressing model is string-based and user-defined.

## Non-goals

- “Durable streams” as a platform feature.
- Automatic AI semantics like `step.ai.infer()` or step-status streaming as a default product surface.
- Designing new backend realtime infrastructure. We aim to reuse existing realtime tech.

---

## Introduction

### Problem statement

Building realtime UIs alongside Inngest currently requires manual work (streams, chunking, connections, state). The `@inngest/realtime` technical preview works, but it is separate from the main SDK, has verbose builder syntax, and lacks schema validation, run lifecycle awareness, and ecosystem integration.

### What users need to do

Users want to:

1. Trigger a run (via events or durable endpoints).
2. Subscribe to updates emitted during the run.
3. Render those updates in their UI with typed data and minimal code, including AI streaming UX.

### Why now

If the realtime experience requires ~100 lines of custom boilerplate, we are not competitive for AI workflows. We need a paved path from “first Inngest function” to “realtime UI.”

---

## Core concepts

### 1) Channels (the address primitive)

Channels are the core namespace for realtime data. Channels are user-defined strings that are flexible enough to represent runs, users, threads, batches, or anything else.

### Declaring channels

```tsx
// shared between server functions and client components
import { realtime } from "inngest";
import { z } from "zod";

// Parameterized channel — the function generates the channel name from user-supplied params.
// Use this when each channel instance represents a different entity (a run, a user, a thread).
export const agentChat = realtime.channel({
  name: ({ threadId }: { threadId: string }) => `agent-chat:${threadId}`,
  topics: {
    status: {
      schema: z.object({
        message: z.string(),
        step: z.string().optional(),
      }),
    },
    tokens: {
      schema: z.object({ token: z.string() }),
    },
  },
});

// Static channel — no parameters, single global namespace.
export const systemAlerts = realtime.channel({
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

// Simple per-run channel — the most common case.
// Stream status messages and a final result from any Inngest function.
export const run = realtime.channel({
  name: ({ runId }: { runId: string }) => `run:${runId}`,
  topics: {
    status: {
      schema: z.object({
        message: z.string(),
      }),
    },
    result: realtime.type<{ success: boolean; output: unknown }>(),
  },
});

// A richer example: tracking the full lifecycle of an AI content pipeline.
// This channel is parameterized by runId so each function execution gets its own stream.
// Multiple topics separate different concerns, each with their own payload shape.
export const contentPipeline = realtime.channel({
  name: ({ runId }: { runId: string }) => `pipeline:${runId}`,
  topics: {
    // Human-readable status updates — shown in a status bar or toast
    status: {
      schema: z.object({
        message: z.string(),
        step: z.string().optional(),
      }),
    },

    // Streamed AI tokens — fed into a live text preview as they arrive
    tokens: {
      schema: z.object({
        token: z.string(),
        model: z.string().optional(),
      }),
    },

    // Structured intermediate results — rendered as cards, tables, or previews
    // e.g. research results, extracted entities, generated images
    artifact: {
      schema: z.object({
        kind: z.enum(["research", "outline", "draft", "image"]),
        title: z.string(),
        body: z.unknown(), // flexible payload — could be markdown, JSON, a URL
      }),
    },

    // Tool call visibility — show the user what the AI is doing under the hood
    toolCall: {
      schema: z.object({
        tool: z.string(),
        input: z.record(z.unknown()),
        result: z.unknown().optional(),
      }),
    },

    // Cost/usage telemetry — display token counts, latency, model info in a debug panel
    usage: realtime.type<{
      inputTokens: number;
      outputTokens: number;
      model: string;
      latencyMs: number;
    }>(),
  },
});
```

**Key design decisions:**

- **Channels are just strings.** The `name` can be a static string or a function that returns a string. This means channels can represent anything.
- **Topics are declared per-channel.** Each topic has either a `schema` (Zod, runtime validation) or is a type-only topic created via `realtime.type<T>()` (TS-only, zero runtime cost). This replaces the verbose `.addTopic(topic("name").type<T>())` builder from `@inngest/realtime`.
- **Type-only topics use `realtime.type<T>()`** — a helper that produces a topic config carrying only a TypeScript type with no runtime schema. This avoids the `{} as T` cast pattern and reads cleanly alongside schema-based topics.
- **One declaration, used everywhere.** The same channel object is imported in functions (to publish) and in UI components (to subscribe). Types flow E2E. *Note*: not entirely sure about this, maybe too much conceptual overhead.

### Instantiating channels

A parameterized channel becomes a concrete channel instance when you pass its params:

```tsx
// given the exported agentChat above
// channel name is "agent-chat:thread_abc123"
const myChat = agentChat({ threadId: "thread_abc123" });

// static channels don't need instantiation
const alerts = systemAlerts;
```

Channel instances are lightweight, serializable value objects. Each topic defined on the channel is also exposed as a **topic accessor** on the instance: a lightweight reference that carries the resolved channel name, topic name, and payload type. These accessors are used when publishing.

```tsx
// myChat.status → TopicRef for "agent-chat:thread_abc123" / "status"
// myChat.tokens → TopicRef for "agent-chat:thread_abc123" / "tokens"
// systemAlerts.alert → TopicRef for "system:alerts" / "alert"
```

### Inferred types

```tsx
// Infer the payload type of a specific topic
// { message: string; step?: string }
type StatusPayload = typeof agentChat.topics.status.$infer;

// Infer the full channel params type
// { threadId: string }
type ChatParams = typeof agentChat.$params;
```

### 2) Topics (typed categories within a channel)

Topics belong to a channel. Each topic defines the shape of one category of message within that channel. The channel+topic pair is the full address for any realtime message.

**Topic definition options:**

| Option | Runtime validation | Bundle cost | Use when |
| --- | --- | --- | --- |
| `schema: z.object({...})` | Yes (opt-in per subscriber) | Includes Zod reference | You want E2E validation or use schemas elsewhere |
| `realtime.type<T>()` | No | Zero runtime cost | Client-only consumption, bundle size matters |

### 3) Message envelope

```tsx
export type RealtimeMessage<T> = {
  channel: string;         // resolved channel name
  topic: string;           // topic key within the channel
  data: T;                 // typed payload
  sentAt: string;          // ISO timestamp
};
```

### 4) Run lifecycle messages

The platform emits well-known lifecycle messages so subscribers can distinguish “the run finished” from “the connection dropped.” These are delivered on a **reserved topic** within whatever channel the function publishes to.

```tsx
// Built-in, exported from "inngest"
// This topic is automatically available on any channel — you don't declare it.
export const RunLifecycle = {
  topic: "inngest/run.lifecycle",
  schema: z.object({
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    error: z
      .object({
        message: z.string(),
        code: z.string().optional(),
      })
      .optional(),
    result: z.unknown().optional(),
  }),
};
```

**Behavior:**

- When a run finishes (success, failure, or cancellation), the platform publishes a final lifecycle message with the terminal status to the channel(s) that function published to.
- The React hook exposes this as a dedicated `runStatus` field (see hooks section) so users never need to subscribe to this topic manually.
- If the connection drops before a lifecycle message is received, the hook’s `status` will be `"error"` (connection-level) while `runStatus` remains `"running"` making the distinction unambiguous.

---

## Channel portability across server/client boundaries

Channel definitions are intended to be **isomorphic,** importable in both server functions and client components. To make this practical across framework boundaries (e.g. Next.js `"use server"` / `"use client"`):

- **`realtime.type<T>()` topics** produce zero-dependency objects safe for any environment. This is the recommended default for client-heavy use cases where bundle size matters.
- **`schema` based topics** (e.g. Zod) carry the validator at runtime. This is designed for server-side validation or shared modules where the schema library is already in the bundle.
- **For client-side tree-shaking**, the recommended pattern is to co-locate channels in a shared `channels.ts` file that avoids importing heavy server dependencies. When a Zod schema is present but only the type is needed client-side, users can import the inferred type only:

```tsx
import { realtime } from "inngest";
import { z } from "zod";

export const agentChat = realtime.channel({
  name: ({ threadId }: { threadId: string }) => `agent-chat:${threadId}`,
  topics: {
    status: { schema: z.object({ message: z.string() }) },
    tokens: { schema: z.object({ token: z.string() }) },
  },
});
```

```tsx
// client component, import the channel object (lightweight) and infer types
import { agentChat } from "@/channels";
import type { typeof agentChat.topics.status.$infer } from "@/channels";
```

- The SDK must ensure that `realtime.channel()` itself does **not** pull in Node-only APIs, so the object is safe to import in browser/edge runtimes.
- Subscriber-side validation (actually invoking the Zod `.parse()`) is **opt-in** and off by default in React hooks to keep the client bundle lean. It can be enabled per-subscription:

```tsx
useRealtime({
  channel: agentChat({ threadId }),
  topics: ["status"],
  validate: true, // opt-in: invokes schema.parse() on each message
});
```

---

## Publishing API

Publishing uses **topic accessors,** dot-access properties on a channel instance that resolve to a typed topic reference. This gives full autocomplete on topic names and constrains the data argument to match the selected topic’s schema.

```tsx
// Signature
publish(topicRef: TopicRef<TData>, data: TData): Promise<void>
```

The topic accessor pattern means `publish` always takes exactly two arguments: *where* (channel + topic, as a single value) and *what* (the typed payload). This keeps the address and payload cleanly separated while giving you dot-access autocomplete on topic names instead of relying on string literals.

### Inside an Inngest function (happy path)

Publishing from a function requires specifying the channel instance and topic. The SDK provides the `publish` helper in the function context.

```tsx
import { agentChat } from "@/channels";

export const aiChat = inngest.createFunction(
  { id: "ai-chat" },
  { event: "ai/chat.requested" },
  async ({ event, step, publish }) => {
    const threadId = event.data.threadId;
    const chat = agentChat({ threadId });

    await publish(chat.status, { message: "Thinking..." });

    const response = await step.run("generate", async () => {
      return llm.generate(event.data.prompt);
    });

    // Stream tokens
    for (const token of response.tokens) {
      await publish(chat.tokens, { token });
    }

    await publish(chat.status, { message: "Done" });
  }
);
```

**Typing:** `publish(chat.tokens, data)` is fully typed.  The topic name is autocompleted via dot-access from the channel instance, and the `data` argument is typed to match that topic’s schema. Accessing an unknown topic is a compile error, and passing the wrong data shape is a compile error.

### Durable publish via `step.realtime.publish`

The context-level `publish` is fire-and-forget: it executes immediately and is **not** memoized. If the function retries, every `publish` call before the failing step will re-execute, producing duplicate messages. For high-frequency streaming (tokens, progress ticks) this is fine since subscribers just see the latest value. But for important state transitions (completion, error, artifact delivery) duplicates can cause incorrect UI state.

`step.realtime.publish` is a durable step. It participates in step memoization, appears in the execution graph, and will not re-fire on retry.

```tsx
import { agentChat } from "@/channels";

export const aiChat = inngest.createFunction(
  { id: "ai-chat" },
  { event: "ai/chat.requested" },
  async ({ event, step, publish }) => {
    const chat = agentChat({ threadId: event.data.threadId });

    // Non-durable: fine for high-frequency streaming where duplicates are harmless
    for (const token of tokens) {
      await publish(chat.tokens, { token });
    }

    // Durable: memoized, won’t re-fire on retry
    await step.realtime.publish("publish-result", chat.status, {
      message: "Done",
    });
  }
);
```

**Signature:**

```tsx
step.realtime.publish(
  id: string | StepOptions,
  topicRef: TopicRef<TData>,
  data: TData
): Promise<TData>
```

**When to use which:**

| | `publish(ref, data)` | `step.realtime.publish(id, ref, data)` |
| --- | --- | --- |
| Durable / memoized | No | Yes |
| Re-fires on retry | Yes | No (skipped via memoization) |
| Visible in execution graph | No | Yes |
| Requires step ID | No | Yes |
| Best for | Token streaming, progress ticks, frequent ephemeral updates | State transitions, final results, artifacts, anything where duplicates matter |

### From server code (explicit, outside a function)

```tsx
import { agentChat } from "@/channels";

await inngest.realtime.publish(
  agentChat({ threadId: "thread_abc" }).status,
  { message: "Externally triggered update" }
);
```

---

## Subscribing API (server / low-level)

### Async iterator (Node/Edge)

```tsx
for await (const msg of inngest.realtime.subscribe({
  channel: agentChat({ threadId }),
  topics: ["status", "tokens"],
})) {
  // msg is a union type: RealtimeMessage<StatusPayload> | RealtimeMessage<TokenPayload>
  // Narrow by topic:
  if (msg.topic === "status") {
    console.log(msg.data.message); // typed
  }
}
```

### Callback style

```tsx
const sub = inngest.realtime.subscribe({
  channel: agentChat({ threadId }),
  topics: ["tokens"],
  onMessage: (msg) => console.log(msg.data.token),
  onError: (err) => console.error(err),
});

sub.unsubscribe();
```

### Auth/token model

Maintain server-minted subscription tokens. Tokens are scoped to a channel + topics.

```tsx
// server route
export async function POST(req: Request) {
  const { threadId } = await req.json();

  const token = await inngest.realtime.token({
    channel: agentChat({ threadId }),
    topics: ["status", "tokens"],
  });

  return Response.json({ token });
}
```

---

## Trigger + subscribe (invoke-and-subscribe)

This is the **primary happy path** for AI and long-running workflows: fire a function and immediately get a typed stream back, with no manual plumbing.

### Server-side: `inngest.realtime.invoke()`

```tsx
// `channelId` the resolved channel name string
// `token` a scoped subscription token for the requested channel+topics
// `stream` an async iterable already subscribed
const { channelId, token, stream } = await inngest.realtime.invoke({
  function: "app/ai-chat",
  data: { threadId: "thread_abc", prompt: "..." },
  channel: agentChat({ threadId: "thread_abc" }),
  topics: ["status", "tokens"],
});
```

**Behavior:**

1. Sends the function invocation (via Durable Endpoints or event send, abstracted away).
2. Mints a subscription token scoped to the specified channel + topics.
3. Opens a subscription and returns the stream, channel ID, and token.

### Returning the stream from a route handler

```tsx
// app/api/chat/route.ts (Next.js example)
import { toResponse } from "inngest/ai/vercel";

export async function POST(req: Request) {
  const { threadId, prompt } = await req.json();

  const { stream } = await inngest.realtime.invoke({
    function: "app/ai-chat",
    data: { threadId, prompt },
    channel: agentChat({ threadId }),
    topics: ["tokens"],
  });

  // Option A: proxy the stream as SSE (AI SDK compatible)
  return toResponse(stream, {
    map: (msg) => msg.data,
  });
}
```

```tsx
// Or Option B: return the token and let the client subscribe directly
export async function POST(req: Request) {
  const { threadId, prompt } = await req.json();

  const { channelId, token } = await inngest.realtime.invoke({
    function: "app/ai-chat",
    data: { threadId, prompt },
    channel: agentChat({ threadId }),
    topics: ["status", "tokens"],
  });

  return Response.json({ channelId, token });
}
```

### Client-side: React `useInvoke` hook

For the most streamlined client experience, a dedicated hook wraps the invoke-and-subscribe flow:

```tsx
import { useInvoke } from "inngest/react";
import { agentChat } from "@/channels";

function ChatUI({ threadId }: { threadId: string }) {
  const { invoke, status, runStatus, latest, error } = useInvoke({
    endpoint: "/api/chat",
    channel: agentChat({ threadId }),
    topics: ["status", "tokens"],
  });

  return (
    <div>
      <button onClick={() => invoke({ threadId, prompt: "Hello" })}>
        Start
      </button>

      {latest.tokens && <span>{latest.tokens.data.token}</span>}
      {latest.status && <p>{latest.status.data.message}</p>}
      {runStatus === "completed" && <p>Done!</p>}
      {runStatus === "failed" && <p>Error: {error?.message}</p>}
    </div>
  );
}
```

**`useInvoke` behavior:**

1. On `invoke(data)`, POSTs to the endpoint with the provided data.
2. Expects the endpoint to return `{ channelId, token }` (Option B pattern above).
3. Automatically opens a realtime subscription using the returned token.
4. Exposes the same `status`, `runStatus`, `latest`, `history`, and `error` fields as `useRealtime`.
5. Handles cleanup (unsubscribe) on unmount or re-invoke.

---

## React hooks (primary UI DX)

Hooks ship from the core SDK distribution (e.g. `inngest/react`).

### Single-channel hook

```tsx
import { useRealtime } from "inngest/react";
import { agentChat } from "@/channels";

const { status, runStatus, latest, error } = useRealtime({
  channel: agentChat({ threadId }),
  topics: ["status", "tokens"],
  token: () =>
    fetch("/api/realtime-token", {
      method: "POST",
      body: JSON.stringify({ threadId }),
    })
      .then((r) => r.json())
      .then((x) => x.token),
});

// Typed access per topic:
latest.status?.data.message;
latest.tokens?.data.token;
```

**Return type:**

```tsx
type UseRealtimeResult<TChannel, TTopics> = {
  /** Connection status */
  status: "idle" | "connecting" | "open" | "closed" | "error";

  /** Run lifecycle status — derived from inngest/run.lifecycle messages */
  runStatus: "unknown" | "running" | "completed" | "failed" | "cancelled";

  /** Most recent message per topic — fully typed map */
  latest: { [K in TTopics]?: RealtimeMessage<InferTopicPayload<TChannel, K>> };

  /** Connection or run-level error */
  error?: Error;

  /** Run result (function return value), available when runStatus is "completed" */
  result?: unknown;

  /** Opt-in bounded message buffer (all topics interleaved) */
  history: RealtimeMessage<unknown>[];

  /** Clear history buffer */
  reset: () => void;
};
```

**`status` vs `runStatus` semantics:**

| Scenario | `status` | `runStatus` |
| --- | --- | --- |
| Hook mounted, not yet connected | `"idle"` | `"unknown"` |
| WebSocket connecting | `"connecting"` | `"unknown"` |
| Connected, run in progress | `"open"` | `"running"` |
| Run completed, connection still open | `"open"` | `"completed"` |
| Run failed | `"open"` | `"failed"` |
| Connection dropped unexpectedly | `"error"` | `"running"` (last known) |
| Connection closed after run completed | `"closed"` | `"completed"` |

The hook auto-closes the connection shortly after receiving a terminal `runStatus` (`"completed"`, `"failed"`, `"cancelled"`), transitioning `status` to `"closed"`.

### Multi-channel subscription

For dashboards or batch UIs that need to observe multiple concurrent channels (e.g., multiple runs, multiple users):

```tsx
import { useRealtimeList } from "inngest/react";
import { agentChat } from "@/channels";

const { channels, subscribe, unsubscribe } = useRealtimeList({
  channel: agentChat,         // the channel definition (not an instance)
  topics: ["status"],
  token: (params) =>          // receives the channel params for per-instance token minting
    fetch("/api/realtime-token", {
      method: "POST",
      body: JSON.stringify(params),
    })
      .then((r) => r.json())
      .then((x) => x.token),
});

// Dynamically add/remove channel instances
subscribe({ threadId: "thread_1" });
subscribe({ threadId: "thread_2" });
unsubscribe({ threadId: "thread_1" });

// Access per-channel state — keyed by resolved channel name
for (const [channelName, state] of channels) {
  console.log(channelName, state.latest.status?.data.message);
}
```

**Return type:**

```tsx
type UseRealtimeListResult<TChannel, TTopics> = {
  /** Map of resolved channel name → per-channel state */
  channels: Map<string, {
    status: "idle" | "connecting" | "open" | "closed" | "error";
    runStatus: "unknown" | "running" | "completed" | "failed" | "cancelled";
    latest: { [K in TTopics]?: RealtimeMessage<InferTopicPayload<TChannel, K>> };
    error?: Error;
    history: RealtimeMessage<unknown>[];
  }>;

  /** Subscribe to a new channel instance */
  subscribe: (params: TChannel["$params"]) => void;

  /** Unsubscribe from a channel instance */
  unsubscribe: (params: TChannel["$params"]) => void;

  /** Unsubscribe from all channels */
  clear: () => void;
};
```

**Behavior:**

- Each channel instance gets its own independent connection and state.
- `token` is a function that receives the channel params so tokens can be minted per-instance.
- The hook cleans up all connections on unmount.
- Bounded to a configurable max concurrent subscriptions (default: 50) to prevent resource exhaustion.

### Hook defaults

- Reconnect with backoff.
- Pause when tab is hidden.
- Bounded history buffers by default (default: 100 messages; configurable via `historyLimit`).
- Auto-close connection after terminal `runStatus`.

---

## AI ecosystem support (thin bridges)

### Principles

- Adapters are shape conversion only: realtime messages → framework streaming protocols.
- Core SDK remains framework-agnostic.
- Primary exports are consistent across adapter packages, while framework-idiomatic aliases exist for discoverability.

### Adapter naming + exports (consistency first)

Each adapter package (`inngest/ai/vercel`, `inngest/ai/tanstack`, `inngest/ai/langchain`) exposes a predictable, scannable surface:

- `toResponse(...)`  for route handlers / SSE Response
- `toStream(...)`  for returning a ReadableStream (where applicable)
- `toEvents(...)`  for event-first frameworks (where applicable)
- `AdapterOptions`  consistent options type name per package

Framework terminology is provided as aliases, not the primary API, to keep the surface consistent.

### inngest/ai/vercel

```tsx
import { toResponse, toStream, type AdapterOptions } from "inngest/ai/vercel";

// Framework-idiomatic alias:
import { toDataStreamResponse } from "inngest/ai/vercel";
```

Example:

```tsx
import { toResponse as toVercelResponse } from "inngest/ai/vercel";
import { agentChat } from "@/channels";

export async function GET() {
  const stream = inngest.realtime.subscribe({
    channel: agentChat({ threadId }),
    topics: ["tokens"],
  });

  return toVercelResponse(stream, {
    map: (msg) => msg.data,
  });
}
```

**Behavior:**

- Emits Vercel AI SDK “data stream” SSE frames.
- Sets any required protocol headers.
- Terminates with `[DONE]`.

### inngest/ai/tanstack

```tsx
import { toResponse, toStream, type AdapterOptions } from "inngest/ai/tanstack";

// Framework-idiomatic alias:
import { toSSE } from "inngest/ai/tanstack";
```

Example:

```tsx
import { toResponse as toTanStackResponse } from "inngest/ai/tanstack";
import { agentChat } from "@/channels";

export function GET() {
  const stream = inngest.realtime.subscribe({
    channel: agentChat({ threadId }),
    topics: ["status"],
  });

  return toTanStackResponse(stream, {
    mapToChunk: (msg) => ({
      type: "data",
      data: msg.data,
      topic: msg.topic,
      sentAt: msg.sentAt,
    }),
  });
}
```

### inngest/ai/langchain

```tsx
import { toEvents, toStream, type AdapterOptions } from "inngest/ai/langchain";

// Framework-idiomatic alias:
import { toStreamEvents } from "inngest/ai/langchain";
```

Example:

```tsx
import { toEvents as toLangChainEvents } from "inngest/ai/langchain";
import { agentChat } from "@/channels";

const stream = inngest.realtime.subscribe({
  channel: agentChat({ threadId }),
  topics: ["tokens"],
});

for await (const event of toLangChainEvents(stream, {
  tokenSelector: (msg) => msg.data.token,
})) {
  // Consume a minimal streamEvents()-style event stream
}
```

### Optional: single discovery entrypoint

```tsx
import { ai } from "inngest/ai";

ai.vercel.toResponse(...)
ai.tanstack.toResponse(...)
ai.langchain.toEvents(...)
```

---

## Performance / correctness

- Validation is optional and configurable per subscription (fast-path for no schema).
- Hook buffers are bounded by default; “infinite history” is opt-in.
- Existing realtime constraints (message size, TTL, plan limits) remain and must be documented prominently.

---

## Migration plan (@inngest/realtime → core)

The new API is an evolution of the existing `channel` + `topic` model, not a replacement of the underlying protocol. Key changes for migrators:

| `@inngest/realtime` | New (core SDK) |
| --- | --- |
| `channel("name").addTopic(topic("t").type<T>())` | `realtime.channel({ name: "name", topics: { t: realtime.type<T>() } })` |
| `channel("name").addTopic(topic("t").schema(z))` | `realtime.channel({ name: "name", topics: { t: { schema: z } } })` |
| `realtimeMiddleware()` on the Inngest client | Built into the core SDK — no middleware needed |
| `import { ... } from "@inngest/realtime"` | `import { realtime } from "inngest"` |
| `useInngestSubscription({ refreshToken })` | `useRealtime({ channel, topics, token })` |
| `publish(channel().topicName(data))` | `publish(channel.topicName, data)` |
| N/A (middleware-based, no durable option) | `step.realtime.publish(id, channel.topicName, data)` (durable, memoized) |
- Deprecate `@inngest/realtime` immediately but keep it available through a transition period.
- The underlying WebSocket protocol and token format remain the same, this is a SDK-level change only.

---

## Observability

Emit SDK telemetry (no payload content):

- subscribe attempt/success/failure
- connection lifetime and reconnect counts
- publish counts, payload sizes
- sdk version + runtime + adapter used