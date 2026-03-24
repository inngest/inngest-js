# Durable Endpoint Streaming

Streams data from an Inngest Durable Endpoint (DE) through the Inngest Server to a waiting client via Server-Sent Events (SSE).

## Flow

A DE streams directly to the client while it runs synchronously. Once the DE goes async (e.g. `step.sleep`, `step.waitForEvent`, or a retryable error), the Inngest Server becomes the intermediary.

```
Phase 1 — Sync (direct)
  Client  ←── SSE ───  DE

Phase 2 — Async (relayed via Inngest Server)
  Client  ←── SSE ───  Inngest Server  ←── POST /realtime/publish/tee ───  DE
```

### How the handoff works

1. Client sends a request to the DE with `Accept: text/event-stream`.
2. DE begins executing and streams SSE frames directly to the client.
3. Once both the first checkpoint completes (providing a realtime token) and the stream is activated (via `push()`/`pipe()`), the DE sends an `inngest.redirect_info` frame containing a realtime SSE URL. This happens eagerly — before async mode — so the client has the URL before the direct connection closes.
4. If the DE goes async, the direct SSE connection closes. The client reconnects to the redirect URL (`GET /v1/realtime/sse?token={jwt}`).
5. When the DE resumes (on re-entry from the Inngest Server), it POSTs its stream body to `POST /v1/realtime/publish/tee?channel={runId}`, which relays frames through Redis pub/sub to the waiting client.

### Without streaming

If the client does not send `Accept: text/event-stream`, the DE behaves exactly as before: it returns a plain JSON response or a 302 redirect to the run output endpoint (`/v1/http/runs/{runId}/output`) for async mode.

If the client sends `Accept: text/event-stream` but the function never calls `stream.push()`/`stream.pipe()`, the result is wrapped in an SSE envelope (a single `inngest.result` frame) rather than returned as plain JSON.

## Modules

| Module | Location | Purpose |
|---|---|---|
| SSE Protocol | [`src/components/execution/streaming.ts`](../../src/components/execution/streaming.ts) | Frame types, builders, parser. [Docs](sse-protocol.md) |
| Server API | [`src/components/InngestStreamTools.ts`](../../src/components/InngestStreamTools.ts) | `stream.push()` and `stream.pipe()`. [Docs](server-api.md) |
| Client API | [`src/stream.ts`](../../src/stream.ts) | `streamRun()` and `subscribeToRun()`. [Docs](client-api.md) |
| Engine | [`src/components/execution/engine.ts`](../../src/components/execution/engine.ts) | Orchestrates SSE responses, redirect, async handoff. |
| Public export | [`src/experimental/durable-endpoints.ts`](../../src/experimental/durable-endpoints.ts) | Re-exports client API as `inngest/experimental/durable-endpoints`. |

## Limitations

- **No late-joiner support.** If a client connects after the DE has already started streaming in async mode, missed frames are lost. There is no buffering or replay.
- **Streaming only works inside steps.** Calling `stream.push()` outside a `step.run()` produces frames without a `step_id`, which means the client cannot roll them back on retry. The exception is a DE with zero steps.
- **Unidirectional.** The client cannot stream data back to the DE.
- **Realtime JWT expiry.** The JWT in the redirect URL expires after 1 minute. If more than 1 minute passes between run creation and async mode, the token may be stale.
- **15-minute SSE cap.** The `GET /v1/realtime/sse` endpoint has a maximum connection duration of 15 minutes.
