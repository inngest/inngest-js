# Durable Endpoints streaming

## High-level

We're implementing streaming to the existing Durable Endpoints (DE) feature. This allows users to stream arbitrary data back to the client, which is extremely useful for AI use cases (e.g. stream back LLM output).

## Status quo

DE is an existing feature. It's effectively a fancy wrapper around normal HTTP endpoints. This wrapper allows users to use Inngest step methods within the HTTP endpoints.

If a DE only has `step.run` calls, then the response is sent back to the user. But if they have any "async mode" steps (`step.sleep`, `step.waitForEvent`, etc.), then we have to do something called "async mode".

### Async mode

When a DE "goes async mode", we have to do a few things:

1. Inform the Inngest Server (IS) that the DE needs to go async mode. This is done via a normal checkpointing outgoing request to the IS.
2. Interrupt control flow within the DE (nothing runs after the async mode step).
3. Immediately return a response to the user. This is not the value returned by the DE.

At some point in the future (e.g. 1 minute later if the async mode step was `step.sleep("zzz", "1m")`), we'll "reenter" the DE via a request sent by the IS. Note that this request is sent by the IS, but the initial client is still ultimately the true "client" from the DE's perspective.

Async mode can also happen when there's an error. For example, if the DE errors on the second `step.run` then the IS will send a retry request.

### Checkpointing

Checkpointing is technically independent of DE (i.e. it can be used in normal Inngest functions), but it's necessary for DE. Checkpointing is the process of sending outgoing requests to the IS to tell it about the steps that are performed.

The checkpointing endpoints are:

- `POST /checkpoint`: Create the DE run and save its first step. This is called after the first step executes.
- `POST /checkpoint/{runId}/steps`: Save a step. This is called for every step except the first step.

Unlike apps with Inngest functions, DE apps don't need to sync with an IS before running.

## What's new

We're adding support for streaming. Users are able to stream arbitrary data back to the client at any arbitrary point in the DE. In other words, we aren't restricting streaming to a returned stream. These "arbitrary streaming" capabilities are table stakes for AI use cases.

We currently have a working demo for this, found in `examples/pocDurpStream`. We've also modified parts of `packages/inngest` to support this demo.

We also need to make some backend changes. These can be found in our "OSS" repo (branch is `poc-durp-streaming`). The changes in OSS are minimal because we only needed to tweak existing endpoints:

- `POST /realtime/publish/tee?channel={runId}`: Stream data to the IS, which ultimately should stream back to the client. Authed with the signing key.
- `GET /v1/realtime/sse?token={realtimeJwt}`: Stream data sent to the other endpoint. The client uses this.

Streaming uses SSE. Our internal events use the `inngest` prefix:

- `inngest.metadata`: Metadata about the DE run (e.g. run ID)
- `inngest.redirect_info`: Information about how the client should redirect to the IS to get the final result (e.g. URL with realtime JWT).
- `inngest.result`: The DE's return value.

Note that `inngest.redirect_info` is sent before the DE does async mode: it's immediately sent once we have the redirect info (after the first checkpoint). We can't send it when going async mode because async mode may have been triggered by an app server crash (which results in a retry sent from the IS).

### Server-side API

Individually chunks are streamed with `stream.push("my chunk")`.

Existing streams can be piped to the client with `stream.pipe(otherStream)`.

#### Example

```ts
import { Inngest } from "inngest";
import { stream } from "inngest/durable-endpoint";
import { endpointAdapter } from "inngest/next";

const inngest = new Inngest({ id: "my-app", endpointAdapter });

export const GET = inngest.endpoint(async () => {
  await step.run("before-async-mode-1", async () => {
    // Streamed directly to the client
    stream.push("Hello\n");
  });

  await step.run("before-async-mode-2", async () => {
    // Streamed directly to the client
    stream.push("World\n");
  });

  // Force async mode
  await step.sleep("zzz", "1s");

  await step.run("after-async-mode", async () => {
    // Streamed to the client via the IS
    stream.push("Hola\n");
    stream.push("mundo\n");
  });

  // Streamed to the client via the IS
  return "All done";
});
```

The following SSE events are streamed directly from the DE to the client:

```
event: inngest.metadata
data: {"run_id":"01KKPZEPCEDA9DCEWFAN33RKMY","attempt":0}

event: stream
data: "Hello\n"

event: inngest.redirect_info
data: {"url":"http://localhost:8288/v1/realtime/sse?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJydC5pbm5nZXN0LmNvbSIsInN1YiI6IjAwMDAwMDAwLTAwMDAtNDAwMC1hMDAwLTAwMDAwMDAwMDAwMCIsImV4cCI6MTc3MzUxODk5NiwiaWF0IjoxNzczNTE4OTM2LCJqdGkiOiIwMUtLUFpFUEQzUzJZVjdBMVAxVE1ZUjE0NCIsImVudiI6IjAwMDAwMDAwLTAwMDAtNDAwMC1iMDAwLTAwMDAwMDAwMDAwMCIsInRvcGljcyI6W3sia2luZCI6InJ1biIsImVudl9pZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC1iMDAwLTAwMDAwMDAwMDAwMCIsImNoYW5uZWwiOiIwMUtLUFpFUENFREE5RENFV0ZBTjMzUktNWSIsIm5hbWUiOiIkc3RyZWFtIn1dLCJwdWJsaXNoIjpmYWxzZX0.pwQ1t20rDhI9TNDP4_ioFQFAEofOijKa_HKmGH8qhNI"}

event: stream
data: "World\n"
```

Once the response ends, the client knows it needs to send a `GET` request to the URL in the `inngest.redirect_info` event data. The following SSE events are streamed DE->IS->client:

```
event: inngest.metadata
data: {"run_id":"01KKPZZ71Z8GCBMCA0FEPH1TZ1"}

event: stream
data: "Hola\n"

event: stream
data: "mundo\n"

event: inngest.result
data: "All done"
```

### Client-side API

This has more unknowns than the server-side API.

High-level requirements:

- Users can easily listen to a stream that filters out our internal events.
- The async mode redirect is minimally exposed to the user. Ideally it's an internal implementation detail.

### Unsolved problems

- How do we clear the stream buffer on the client when the DE is retried? We don't want old events from a previous attempt to be streamed to the client.
- How do we handle realtime JWT expiration? It has a 1 minute expiry, so we have a problem if >=1m elapses between run creation and async mode.
- How do we handle the `GET /v1/realtime/sse` request taking >=15m? The endpoint has a max duration of 15 minutes.

## Out of scope

These are features that we are not implementing right now.

- **Solving the late-joiner problem**. If the client joins after the DE has already started streaming to the IS, then tough luck.
- **Streaming outside of steps**. If a user streams outside of a `step.run` then they'll get undefined behavior. The only exception is when the DE has 0 total steps (that's OK).
- **Bidirectional streaming**. The client cannot stream back: it's only a consumer.

## Glossary

- **Client**: What sent the initial request to the DE. This is typically a browser, but could be anything that can send an HTTP request.
- **Durable Endpoint (DE)**: A special type of HTTP endpoint that allows users to use Inngest step methods within it.
- **Inngest Server (IS)**: The Inngest backend (Dev Server for local dev, Cloud for production).
