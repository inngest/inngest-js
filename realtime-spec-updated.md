# Realtime SDK DX Improvements [Draft]

Status: Not started
Author: Jacob
Created At: February 12, 2026 9:35 AM
Last Edited: February 25, 2026

## Context / goals

This spec defines the Realtime SDK experience inside the core inngest JS/TS SDK (v4) that makes it easy to:

- Trigger an Inngest function run and subscribe to typed updates from that run.
- Build realtime UIs (React-first) without thinking about connections, chunking, parsing, or lifecycle.
- Support both product UI status updates and AI streaming (tokens, tool calls, structured outputs).

## Design priorities

- **Developer ergonomics first:** minimal boilerplate, great autocomplete, reasonable defaults.
- **Simple, self-describing APIs:** the happy path should be obvious from autocomplete/types alone.
- **Declarative realtime use cases:** declare the shape of your channels and topics once, then subscribe by what you want.
- **E2E typing:** shared types/validation between publisher (function) and subscriber (UI/server).
- **Ecosystem fit:** feels idiomatic in modern JS/TS (React 18+, Next, TanStack), and integrates cleanly with AI libraries via adapters.
- **Extensibility:** the addressing model is string-based and user-defined.

## Non-goals

- "Durable streams" as a platform feature.
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

If the realtime experience requires ~100 lines of custom boilerplate, we are not competitive for AI workflows. We need a paved path from "first Inngest function" to "realtime UI."

---

## Core concepts

### 1) Channels (the address primitive)

Channels are the core namespace for realtime data. Channels are user-defined strings that are flexible enough to represent runs, users, threads, batches, or anything else.

### Declaring channels

Topics are typed using [Standard Schema](https://standardschema.dev/) (the same spec used elsewhere in the SDK for event schemas, invoke triggers, etc.). Any Standard Schema compatible library works: Zod, Valibot, ArkType, and others. For type-only topics that don't need runtime validation, use `staticSchema<T>()` from `"inngest"`, which returns a passthrough Standard Schema with zero validation cost.

```tsx
import { realtime, staticSchema } from "inngest";
import { z } from "zod"; // or valibot, arktype, etc.

// Parameterized channel -- the function generates the channel name from user-supplied params.
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

// Static channel -- no parameters, single global namespace.
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

// Simple per-run channel -- the most common case.
// Stream status messages and a final result from any Inngest function.
export const run = realtime.channel({
  name: ({ runId }: { runId: string }) => `run:${runId}`,
  topics: {
    status: {
      schema: z.object({
        message: z.string(),
      }),
    },
    result: {
      schema: staticSchema<{ success: boolean; output: unknown }>(),
    },
  },
});

// A richer example: tracking the full lifecycle of an AI content pipeline.
// This channel is parameterized by runId so each function execution gets its own stream.
// Multiple topics separate different concerns, each with their own payload shape.
export const contentPipeline = realtime.channel({
  name: ({ runId }: { runId: string }) => `pipeline:${runId}`,
  topics: {
    // Human-readable status updates -- shown in a status bar or toast
    status: {
      schema: z.object({
        message: z.string(),
        step: z.string().optional(),
      }),
    },

    // Streamed AI tokens -- fed into a live text preview as they arrive
    tokens: {
      schema: z.object({
        token: z.string(),
        model: z.string().optional(),
      }),
    },

    // Structured intermediate results -- rendered as cards, tables, or previews
    // e.g. research results, extracted entities, generated images
    artifact: {
      schema: z.object({
        kind: z.enum(["research", "outline", "draft", "image"]),
        title: z.string(),
        body: z.unknown(), // flexible payload -- could be markdown, JSON, a URL
      }),
    },

    // Tool call visibility -- show the user what the AI is doing under the hood
    toolCall: {
      schema: z.object({
        tool: z.string(),
        input: z.record(z.unknown()),
        result: z.unknown().optional(),
      }),
    },

    // Cost/usage telemetry -- display token counts, latency, model info in a debug panel
    usage: {
      schema: staticSchema<{
        inputTokens: number;
        outputTokens: number;
        model: string;
        latencyMs: number;
      }>(),
    },
  },
});
```

**Key design decisions:**

- **Channels are just strings.** The `name` can be a static string or a function that returns a string. This means channels can represent anything.
- **Topics are declared per-channel.** Each topic has a `schema` that is any [Standard Schema](https://standardschema.dev/) compatible value. For runtime validation, use Zod, Valibot, ArkType, etc. For type-only topics with no runtime cost, use `staticSchema<T>()`. This replaces the verbose `.addTopic(topic("name").type<T>())` builder from `@inngest/realtime`.
- **`staticSchema<T>()`** is the same helper already used elsewhere in the SDK (event schemas, invoke triggers). It returns a Standard Schema compliant passthrough, meaning topics always have one config shape (`{ schema }`) regardless of whether they validate at runtime.
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
// myChat.status -> TopicRef for "agent-chat:thread_abc123" / "status"
// myChat.tokens -> TopicRef for "agent-chat:thread_abc123" / "tokens"
// systemAlerts.alert -> TopicRef for "system:alerts" / "alert"
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
| `schema: z.object({...})` (or any Standard Schema) | Yes (opt-in per subscriber) | Includes schema library | You want E2E validation or use schemas elsewhere |
| `schema: staticSchema<T>()` | No | Zero runtime cost | Client-only consumption, bundle size matters |

### 3) Message envelope

```tsx
export type RealtimeMessage<T> = {
  channel: string;         // resolved channel name
  topic: string;           // topic key within the channel
  data: T;                 // typed payload
  sentAt: string;          // ISO timestamp
};
```

### 4) Run lifecycle

The platform emits well-known lifecycle messages so subscribers can distinguish "the run finished" from "the connection dropped." These are delivered on a reserved topic within whatever channel the function publishes to.

**Behavior:**

- When a run finishes (success, failure, or cancellation), the platform publishes a final lifecycle message with the terminal status to the channel(s) that function published to.
- The React hook exposes this as a dedicated `runStatus` field (see hooks section) so users never need to subscribe to this topic manually.
- If the connection drops before a lifecycle message is received, the hook's `status` will be `"error"` (connection-level) while `runStatus` remains `"running"` making the distinction unambiguous.

---

## Channel portability across server/client boundaries

Channel definitions are intended to be **isomorphic,** importable in both server functions and client components. To make this practical across framework boundaries (e.g. Next.js `"use server"` / `"use client"`):

- **`staticSchema<T>()` topics** produce zero-dependency objects safe for any environment. This is the recommended default for client-heavy use cases where bundle size matters.
- **Standard Schema based topics** (e.g. Zod, Valibot) carry the validator at runtime. This is designed for server-side validation or shared modules where the schema library is already in the bundle.
- **For client-side tree-shaking**, the recommended pattern is to co-locate channels in a shared `channels.ts` file that avoids importing heavy server dependencies. When a schema is present but only the type is needed client-side, users can import the inferred type only:

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
- Subscriber-side validation (actually invoking the schema's `.validate()`) is **opt-in** and off by default in React hooks to keep the client bundle lean. It can be enabled per-subscription:

```tsx
useRealtime({
  channel: agentChat({ threadId }),
  topics: ["status"],
  validate: true, // opt-in: invokes schema validate on each message
});
```

---

## Publishing API

Publishing uses **topic accessors,** dot-access properties on a channel instance that resolve to a typed topic reference. This gives full autocomplete on topic names and constrains the data argument to match the selected topic's schema.

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

**Typing:** `publish(chat.tokens, data)` is fully typed.  The topic name is autocompleted via dot-access from the channel instance, and the `data` argument is typed to match that topic's schema. Accessing an unknown topic is a compile error, and passing the wrong data shape is a compile error.

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

    // Durable: memoized, won't re-fire on retry
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

## React hooks (primary UI DX)

Hooks ship from the core SDK distribution (e.g. `inngest/react`).

### `useRealtime`

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

  /** Run lifecycle status -- derived from platform lifecycle messages */
  runStatus: "unknown" | "running" | "completed" | "failed" | "cancelled";

  /** Most recent message per topic -- fully typed map */
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

### Hook defaults

- Reconnect with backoff.
- Pause when tab is hidden.
- Bounded history buffers by default (default: 100 messages; configurable via `historyLimit`).
- Auto-close connection after terminal `runStatus`.

---

## Performance / correctness

- Validation is optional and configurable per subscription (fast-path when using `staticSchema`).
- Hook buffers are bounded by default; "infinite history" is opt-in.
- Existing realtime constraints (message size, TTL, plan limits) remain and must be documented prominently.

---

## Observability

Emit SDK telemetry (no payload content):

- subscribe attempt/success/failure
- connection lifetime and reconnect counts
- publish counts, payload sizes
- sdk version + runtime + adapter used

---

## Appendix: Future phases

The following features are out of scope for phase 1 but are planned for future phases.

### Phase 2: Invoke-and-subscribe

The primary happy path for AI and long-running workflows: fire a function and immediately get a typed stream back, with no manual plumbing. Rather than introducing a separate `inngest.realtime.invoke()`, this will extend the existing first-class `inngest.invoke()` with realtime subscription options so that invocation and subscription are a single operation.

**Direction (not fully specified):**

```tsx
// Server-side: invoke a function and get a realtime stream back
const { channelId, token, stream } = await inngest.invoke({
  function: "app/ai-chat",
  data: { threadId: "thread_abc", prompt: "..." },
  // Realtime subscription options alongside the invocation
  realtime: {
    channel: agentChat({ threadId: "thread_abc" }),
    topics: ["status", "tokens"],
  },
});
```

This would also include:

- **Route handler helpers** for proxying the stream as SSE or returning the token to the client.
- **`useInvoke` React hook** that wraps the invoke-and-subscribe flow: POSTs to an endpoint, receives a token, and automatically opens a realtime subscription with the same `status`, `runStatus`, `latest`, `history`, and `error` fields as `useRealtime`.

### Future: Multi-channel subscriptions (`useRealtimeList`)

For dashboards or batch UIs that need to observe multiple concurrent channels (e.g., multiple runs, multiple users), a `useRealtimeList` hook would manage a dynamic set of channel subscriptions with per-instance state, token minting, and lifecycle management. Until then, multiple `useRealtime` instances can be rendered in separate components.

### Future: AI ecosystem adapters

The subscribe API returns async iterables, which can be adapted to framework-specific streaming protocols (Vercel AI SDK, TanStack, LangChain) via thin adapter packages. These adapters would be shape-conversion only (realtime messages to framework streaming protocols) and shipped as separate entry points (e.g. `inngest/ai/vercel`, `inngest/ai/tanstack`).
