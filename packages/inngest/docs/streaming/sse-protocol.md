# SSE Protocol

Defines the Server-Sent Events wire format used by Durable Endpoint streaming. The protocol is implemented in [`streaming.ts`](../../src/components/execution/streaming.ts) and shared between server and client code (no Node.js imports).

## Wire format

Every frame follows the standard SSE format:

```
event: <type>
data: <json>\n\n
```

The `event` field is the frame type. The `data` field is always a single line of JSON. The `data` value is never `undefined` — it is normalized to `null` so that the line is always valid JSON.

## Frame types

### `inngest.metadata`

Sent once at the beginning of a stream. Provides run context.

```
event: inngest.metadata
data: {"run_id":"01KKPZEPCEDA9DCEWFAN33RKMY"}
```

| Field | Type | Description |
|---|---|---|
| `run_id` | `string` | The Durable Endpoint run ID. |

### `stream`

User data pushed via `stream.push()` or `stream.pipe()`. This is the only frame type that carries application data.

```
event: stream
data: {"data":"Hello world","step_id":"hashed-step-id"}
```

| Field | Type | Description |
|---|---|---|
| `data` | `unknown` | The value passed to `push()` or a single chunk from `pipe()`. JSON-serialized. |
| `step_id` | `string?` | Hashed ID of the step that produced this chunk. Used by the client for rollback tracking. Absent if pushed outside a step. |

### `inngest.step`

Step lifecycle events emitted by the execution engine. Three statuses:

**Running** — emitted when a step begins execution:
```
event: inngest.step
data: {"step_id":"my-step","status":"running"}
```

**Completed** — emitted when a step succeeds:
```
event: inngest.step
data: {"step_id":"my-step","status":"completed","data":"step return value"}
```

**Errored** — emitted when a step fails:
```
event: inngest.step
data: {"step_id":"my-step","status":"errored","data":{"will_retry":true,"error":"something broke"}}
```

| Field | Type | Description |
|---|---|---|
| `step_id` | `string` | The step's hashed ID. |
| `status` | `"running" \| "completed" \| "errored"` | Lifecycle stage. |
| `data` | `unknown?` | Running/completed: arbitrary data or step return value. Errored: a `{ will_retry, error }` object (see below). |

For errored frames, `data` contains:

| Field | Type | Description |
|---|---|---|
| `will_retry` | `boolean` | Whether the step will be retried. |
| `error` | `string` | Error message. |

Note: The parser (`parseSSEFrame`) flattens errored frames — the parsed `SSEStepErroredFrame` TypeScript type has `will_retry` and `error` at the top level (not nested in `data`).

### `inngest.redirect_info`

Tells the client where to reconnect when the DE goes async. Sent eagerly after the first checkpoint — before the DE actually switches to async mode — so the client has the URL before the direct connection closes.

```
event: inngest.redirect_info
data: {"run_id":"01KKPZEPCEDA9DCEWFAN33RKMY","token":"eyJ...","url":"http://localhost:8288/v1/realtime/sse?token=eyJ..."}
```

| Field | Type | Description |
|---|---|---|
| `run_id` | `string` | The run ID. |
| `token` | `string` | Realtime JWT for authentication. |
| `url` | `string?` | Full SSE URL to reconnect to. When present, the client can connect directly. |

### `inngest.result`

Terminal frame. Always the last frame before the stream closes.

**Succeeded:**
```
event: inngest.result
data: {"status":"succeeded","data":"return value"}
```

**Failed:**
```
event: inngest.result
data: {"status":"failed","error":"NonRetriableError: bad input"}
```

| Field | Type | Description |
|---|---|---|
| `status` | `"succeeded" \| "failed"` | Outcome. |
| `data` | `unknown?` | Succeeded only. The function's return value. |
| `error` | `string` | Failed only. Error message. |

## Internal vs. user frames

Frames prefixed with `inngest.` are internal control frames. The `stream` frame is the only user-facing data frame. The client-side `streamRun()` API processes internal frames automatically (redirect following, rollback, lifecycle hooks) and only surfaces `stream` data to the consumer.

## Parsing pipeline

```
ReadableStream<Uint8Array>
  → iterSSE()         — async generator yielding RawSSEEvent { event, data }
  → parseSSEFrame()   — validates with Zod, returns typed SSEFrame | undefined
```

`iterSSE()` handles SSE line parsing (splitting on `\n\n`, extracting `event:` and `data:` fields). `parseSSEFrame()` dispatches on the event name and validates the JSON payload against Zod schemas. Unrecognized event types return `undefined` and are silently skipped.

## Validation schemas

Each frame type has a corresponding Zod schema for runtime validation:

| Frame | Schema |
|---|---|
| `inngest.metadata` | `sseMetadataPayloadSchema` |
| `stream` | `sseStreamPayloadSchema` |
| `inngest.step` | `sseStepPayloadSchema` + `stepErrorDataSchema` |
| `inngest.result` | `sseResultPayloadSchema` (discriminated union on `status`) |
| `inngest.redirect_info` | `sseRedirectPayloadSchema` |

## Frame builders

Utility functions for constructing SSE frame strings on the server side:

| Function | Frame type |
|---|---|
| `buildSSEMetadataFrame(runId)` | `inngest.metadata` |
| `buildSSEStreamFrame(data, stepId?)` | `stream` |
| `buildSSEStepFrame(stepId, status, data?)` | `inngest.step` |
| `buildSSESucceededFrame(data)` | `inngest.result` (succeeded) |
| `buildSSEFailedFrame(error)` | `inngest.result` (failed) |
| `buildSSERedirectFrame({ run_id, token, url? })` | `inngest.redirect_info` |

All builders return a complete SSE frame string including the trailing `\n\n`.

## Stream utilities

| Function | Purpose |
|---|---|
| `prependToStream(prefix, stream)` | Returns a new `ReadableStream` that emits `prefix` bytes before piping the original stream. Used to prepend the metadata frame. |
| `drainStream(stream)` | Reads a stream to completion, returning all chunks. |
| `drainStreamWithTimeout(stream, ms)` | Like `drainStream` but with a timeout guard. Cancels the reader on timeout. |
| `mergeChunks(chunks)` | Concatenates `Uint8Array[]` into a single `Uint8Array`. |
