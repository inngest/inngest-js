# Durable Endpoint Streaming

Stream arbitrary data from a Durable Endpoint (DE) to the client via SSE.

A key use case is AI streaming (e.g. streaming LLM output to the browser).

## How it works

In sync mode, if the request includes `Accept: text/event-stream`, the DE returns an SSE response immediately while the function continues executing steps in the background. After async mode (e.g. `step.sleep`), the DE streams to the Inngest Server (IS) instead, which relays to the client via a redirect URL.

The client receives an `inngest.redirect_info` event containing a URL. When the direct stream ends, the client reconnects to that URL to receive the remaining events.

## SSE events

| Event                   | Direction       | Purpose                                                       |
| ----------------------- | --------------- | ------------------------------------------------------------- |
| `inngest.metadata`      | DE/IS -> client | Run ID                                                        |
| `inngest.stream`        | DE/IS -> client | User data chunk. Includes `hashedStepId` when inside a step   |
| `inngest.commit`        | DE/IS -> client | Step data is finalized, will not be rolled back               |
| `inngest.rollback`      | DE/IS -> client | Step data should be discarded (error/retry)                   |
| `inngest.redirect_info` | DE -> client    | URL for async reconnection                                    |
| `inngest.response`      | DE/IS -> client | Terminal event with the HTTP response (status, headers, body) |

## Server API

```ts
await step.run("generate", async () => {
  stream.push("chunk"); // push a single value
  await stream.pipe(readableStream); // pipe a stream
});
```

Streaming outside of `step.run` is undefined behavior (except when the DE has zero steps).

## Client API

```ts
import { streamRun } from "inngest/experimental/durable-endpoints/client";

await streamRun("/api/demo", {
  onData: ({ data }) => console.log(data),
  onCommit: ({ hashedStepId }) => {
    /* commit uncommitted data */
  },
  onRollback: ({ hashedStepId }) => {
    /* discard uncommitted data */
  },
  onStreamError: (error) => console.error(error),
});
```

`streamRun` handles the redirect transparently.

## Inngest server endpoints

- `POST /v1/realtime/publish/tee?channel={runId}` -- DE streams data to Inngest Server (signing key auth)
- `GET /v1/realtime/sse?token={realtimeJwt}` -- Client reads async stream

## Constraints

- No late-joiner support: client must connect before async streaming starts
- No streaming outside steps (except zero-step DEs)
- Unidirectional: client is read-only
- Realtime JWT has 15 minute expiry (unsolved for long sync phases)

## Glossary

- **DE**: Durable Endpoint
- **IS**: Inngest server