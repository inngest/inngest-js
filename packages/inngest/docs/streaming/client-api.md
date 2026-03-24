# Client-Side Stream API

Provides `streamRun()` (high-level, hook-based) and `subscribeToRun()` (low-level, async generator) for consuming Durable Endpoint SSE streams. Implemented in [`stream.ts`](../../src/stream.ts), exported from `inngest/experimental/durable-endpoints`.

## Quick start

```ts
import { streamRun } from "inngest/experimental/durable-endpoints";

// Hook-based — just await
await streamRun<string>("/api/demo", {
  parse: (d) => String(d),
  onData: (chunk) => process.stdout.write(chunk),
  onRollback: (n) => console.log(`rolled back ${n} chunks`),
  onFunctionSucceeded: (data) => console.log("done:", data),
  onFunctionFailed: (err) => console.error("failed:", err),
});

// Or iterate directly
for await (const chunk of streamRun<string>("/api/demo")) {
  process.stdout.write(chunk);
}
```

## API

### `streamRun<TData>(url, opts?): RunStream<TData>`

Factory function. Returns a `RunStream` that is both **awaitable** and **async-iterable**.

- **Await**: `await streamRun(url, opts)` — consumes the stream using hooks only. Resolves when the stream ends.
- **Iterate**: `for await (const chunk of streamRun(url))` — yields parsed data chunks. Hooks still fire alongside iteration.

A `RunStream` can only be consumed once. Attempting to consume it a second time throws.

### `subscribeToRun(opts): AsyncGenerator<SSEFrame>`

Low-level async generator. Fetches the DE endpoint, parses SSE frames, and transparently follows `inngest.redirect_info` redirects. Yields every `SSEFrame` including internal control frames.

Use this when you need full control over frame processing. For most use cases, `streamRun()` is easier.

```ts
import { subscribeToRun } from "inngest/experimental/durable-endpoints";

for await (const frame of subscribeToRun({ url: "/api/demo" })) {
  console.log(frame.type, frame);
}
```

## Options

```ts
interface RunStreamOptions<TData> {
  url: string;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
  parse?: (data: unknown) => TData;

  // Data hooks
  onData?: (data: TData) => void;
  onRollback?: (count: number) => void;

  // Function lifecycle
  onFunctionSucceeded?: (data: unknown) => void;
  onFunctionFailed?: (error: string) => void;

  // Step lifecycle
  onStepRunning?: (stepId: string, data?: unknown) => void;
  onStepCompleted?: (stepId: string, data?: unknown) => void;
  onStepErrored?: (stepId: string, info: StepErrorInfo) => void;

  // Stream lifecycle
  onMetadata?: (runId: string) => void;
  onDone?: () => void;
  onError?: (error: unknown) => void;
}
```

### Hook reference

| Hook | When | Notes |
|---|---|---|
| `onData` | Each `stream` frame | Receives the parsed chunk. Also yielded by the async iterator. |
| `onRollback` | Step error or disconnect | `count` is the number of chunks removed. |
| `onFunctionSucceeded` | `inngest.result` with `status: "succeeded"` | `data` is the function's return value. |
| `onFunctionFailed` | `inngest.result` with `status: "failed"` | Only fires for permanent failures (`NonRetriableError`, exhausted retries). Retryable errors end the stream silently — no result frame. |
| `onStepRunning` | `inngest.step` with `status: "running"` | |
| `onStepCompleted` | `inngest.step` with `status: "completed"` | `data` is the step's return value. |
| `onStepErrored` | `inngest.step` with `status: "errored"` | `info.willRetry` indicates if the step will retry. |
| `onMetadata` | `inngest.metadata` | Receives the `run_id`. |
| `onDone` | Stream fully consumed | Fires in `finally` — always runs, even on error or abort. |
| `onError` | Network failure, non-200, etc. | The error is also re-thrown from the awaited promise. |

### `parse`

Optional transform applied to each `stream` frame's `data` before `onData` fires and before the chunk is yielded by the iterator. Defaults to identity (`(d) => d as TData`).

```ts
await streamRun<string>("/api/demo", {
  parse: (d) => typeof d === "string" ? d : JSON.stringify(d),
  onData: (chunk) => { /* chunk is guaranteed to be string */ },
});
```

## Rollback system

Chunks are tagged with the `step_id` of the step that produced them. This enables automatic rollback when a step fails and will be retried.

### How it works

1. When a `stream` frame arrives, the chunk is stored with its `step_id` tag.
2. When `inngest.step` `completed` arrives, all chunks for that `step_id` are **committed** — their tag is cleared, making them permanent.
3. When `inngest.step` `errored` arrives, all uncommitted chunks for that `step_id` are removed. `onRollback(count)` fires with the number removed, then `onStepErrored` fires.
4. On disconnect (stream ends with steps still in-flight), the client synthesizes rollback + `onStepErrored({ willRetry: false, error: "stream disconnected" })` for each in-flight step.

### Why committed chunks survive

A step might succeed, then a later step might fail and trigger a retry that re-executes the earlier step. Since the first step's chunks were committed on completion, they survive the later rollback. Only chunks from the retried attempt (which haven't been committed yet) are removed.

### Parallel steps

Each parallel step has its own `step_id`. If one parallel step errors, only that step's chunks are rolled back — chunks from other parallel steps are unaffected.

## Redirect following

`subscribeToRun()` (and by extension `streamRun()`) follows `inngest.redirect_info` frames transparently:

1. When the frame arrives, the redirect URL is stored.
2. Remaining frames from the current response are still consumed and yielded.
3. After the current response ends, a new `GET` request is made to the redirect URL with `Accept: text/event-stream`.
4. Frames from the new connection are yielded seamlessly.

The consumer sees a single continuous stream of frames. The redirect is invisible at the `streamRun()` level — `inngest.redirect_info` frames are not surfaced to any hook. To observe them, use `subscribeToRun()` directly.

## Chunk accumulation

`RunStream` accumulates parsed chunks in `.chunks` (read-only). This is useful for building the complete output:

```ts
const run = streamRun<string>("/api/demo", {
  parse: (d) => String(d),
  onFunctionSucceeded: () => {
    console.log("Full output:", run.chunks.join(""));
  },
});
await run;
```

Chunks are automatically removed during rollback, so `.chunks` always reflects the current valid state.

## Footguns

- **Single consumption.** A `RunStream` can only be consumed once (await or iterate). A second attempt throws `"RunStream has already been consumed"`.
- **`onFunctionFailed` does not fire for retryable errors.** When a step errors with `will_retry: true`, the DE goes async to retry. The direct SSE connection simply ends — no `inngest.result` frame is sent. The client should reconnect via the redirect URL to pick up the retried execution.
- **`onRollback` fires before `onStepErrored`.** Update your UI state (remove chunks) before the error handler runs.
- **`onError` re-throws.** If `onError` is set, the error is passed to it *and* re-thrown from the awaited promise. Both fire.
- **No reconnection.** If the network drops after the redirect URL is consumed, the client does not automatically reconnect. Implement your own retry logic around `streamRun()` if needed.
- **`parse` errors are not caught.** If your `parse` function throws, the error propagates and ends the stream.
