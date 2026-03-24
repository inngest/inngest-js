# Server-Side Stream API

The `stream` export provides `push()` and `pipe()` for streaming data to the client from within Durable Endpoint functions. Implemented in [`InngestStreamTools.ts`](../../src/components/InngestStreamTools.ts).

## Quick start

```ts
import { Inngest, step, stream } from "inngest";
import { endpointAdapter } from "inngest/next";

const inngest = new Inngest({ id: "my-app", endpointAdapter });

export const GET = inngest.endpoint(async (req) => {
  const text = await step.run("generate", async () => {
    // Push individual chunks
    stream.push("Generating...\n");

    // Pipe an async source and collect the result
    const result = await stream.pipe(async function* () {
      yield "Hello ";
      yield "world";
    });

    return result; // "Hello world"
  });

  await step.sleep("pause", "5s");

  await step.run("summarize", async () => {
    stream.push({ type: "summary", text });
  });

  return { done: true };
});
```

## API

### `stream.push(data: unknown): void`

Write a single SSE `stream` frame. The `data` value is JSON-serialized. Fire-and-forget — errors are swallowed.

- The current step's hashed ID is automatically attached as `step_id` for client-side rollback tracking.
- If `data` is not JSON-serializable (e.g. circular reference), the call is silently skipped.
- Outside an Inngest execution context, `push()` is a no-op.

### `stream.pipe(source: PipeSource): Promise<string>`

Pipe a source to the client, writing each chunk as an SSE `stream` frame. Returns the concatenated content of all chunks when the source is fully consumed.

Accepted source types (`PipeSource`):

| Type | Behavior |
|---|---|
| `ReadableStream` | Piped directly; each chunk is decoded to string. |
| `AsyncIterable<string>` | Iterated; each yielded value becomes a frame. |
| `() => AsyncIterable<string>` | Factory invoked lazily, then iterated. Useful for async generator functions. |

- Like `push()`, each chunk gets the current step's `step_id`.
- Outside an Inngest execution context, returns `""`.

### Common pattern: stream and collect

```ts
const result = await stream.pipe(async function* () {
  for await (const token of llm.stream("Tell me a joke")) {
    yield token;
  }
});
// result contains the full concatenated text
// client received each token as it was generated
```

## How it works

### Activation

The first call to `push()` or `pipe()` **activates** the stream. Activation triggers the execution engine to return the SSE `Response` to the HTTP handler immediately, rather than waiting for the function to complete. Subsequent steps continue executing in the background while the response streams.

Before activation, the engine hasn't committed to an SSE response — the function could still return a plain JSON value or a custom `Response` object. This lazy activation means streaming has zero overhead for non-streaming DEs.

### InngestStream internals

Each execution gets its own `InngestStream` instance, stored in AsyncLocalStorage. The exported `stream` object is a thin proxy that resolves the current execution's `InngestStream` via ALS.

```
stream.push(data)
  → ALS lookup → InngestStream.push(data)
    → activate() (first call only → fires onActivated callback)
    → currentStepId() (ALS lookup for step_id)
    → buildSSEStreamFrame(data, stepId)
    → enqueue(frame) onto writeChain
      → writer.write(encoder.encode(frame))
```

Key internals:

- **`TransformStream<Uint8Array>`**: The underlying stream. The readable side is consumed by the HTTP response; the writable side is fed by `push`/`pipe`.
- **`writeChain`**: A promise chain that serializes writes. Each `enqueue()` call appends to the chain so writes are ordered even when called concurrently.
- **`onActivated` callback**: Set by the execution engine. In sync mode, this resolves the deferred `earlyStreamResponse` promise that races against the core execution loop.
- **High water mark**: The readable side uses `CountQueuingStrategy({ highWaterMark: 1024 })` to prevent backpressure from blocking writes before the consumer starts reading.

### Step lifecycle frames

The execution engine (not user code) emits `inngest.step` frames through the stream:

- **`step:running`** — before a step's function executes
- **`step:completed`** — after a step succeeds
- **`step:errored`** — after a step fails (includes `will_retry` and `error`)

These are emitted via `InngestStream.stepLifecycle()`, which is an internal method not exposed on the `StreamTools` interface.

### Redirect and async handoff

When the execution engine has both:
1. A realtime token (from the first checkpoint response), and
2. An activated stream

...it sends an `inngest.redirect_info` frame. This happens eagerly so the client has the redirect URL before the DE goes async.

When the DE actually goes async:
- **Sync mode**: The stream's writer is closed (via `end()`), ending the direct SSE connection. The client reconnects to the redirect URL.
- **Async mode (re-entry)**: The stream body is POSTed to `POST /v1/realtime/publish/tee?channel={runId}`, which relays frames through Redis pub/sub to the waiting client.

### runToCompletion mode

When a DE is invoked with `forceExecution: true` (e.g. a direct HTTP call without the Inngest Server), the engine runs in `runToCompletion` mode. In this mode:

- All steps execute locally instead of returning `step-ran` after each step.
- Parallel steps (`Promise.all`) are executed sequentially to avoid deadlocks.
- Checkpoints are fire-and-forget (the engine doesn't wait for the Inngest Server).
- The final result is delivered via the SSE stream if the client accepts it.

## Footguns

- **`push()` outside a step has no `step_id`.** The client can't roll back these chunks on retry. Only push from within `step.run()` callbacks.
- **Activation is irreversible.** Once `push()` or `pipe()` is called, the response will be SSE. You can't fall back to a plain JSON response.
- **`pipe()` awaits the source.** The step's function is blocked until the source is fully consumed. If the source hangs, the step hangs.
- **Write errors are swallowed.** If the client disconnects mid-stream, writes fail silently. The `onWriteError` callback logs diagnostics but doesn't interrupt execution.
- **ALS resolution has a fallback path.** If the sync ALS lookup fails (e.g. during module initialization), `push()` falls back to an async lookup. This means the first `push()` in a new context may not activate the stream synchronously. In practice this is transparent, but it explains why `push()` returns `void` rather than a promise.
