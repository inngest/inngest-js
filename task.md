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

At some point in the future (e.g. 1 minute later if the async mode step was `step.sleep("zzz", "1m")`), we'll "reenter" the DE via a request sent by the IS. Note that this request is sent by the IS, but the initial client is still ultimately the true "client" from the DE's perspective. This means the client is responsible for sending a request to the IS to get the DE's return value.

### Checkpointing

Checkpointing is technically independent of DE (i.e. it can be used in normal Inngest functions), but it's necessary for DE. Checkpointing is the process of sending outgoing requests to the IS to tell it about the steps that are performed.

The checkpointing endpoints are:

- `POST /checkpoint`: Create the DE run and save its first step. This is called after the first step executes.
- `POST /checkpoint/{runId}/steps`: Save a step. This is called for every step except the first step.

## What's new

We're adding support for streaming. Users are able to stream arbitrary data back to the client at any arbitrary point in the DE. In other words, we aren't restricting streaming to a returned stream. These "arbitrary streaming" capabilities are table stakes for AI use cases.

We currently have a working demo for this, found in `examples/pocDurpStream`. We've also modified parts of `packages/inngest` to support this demo.

We also need to make some backend changes. These can be found in our "OSS" repo (branch is `poc-durp-streaming`). The changes in OSS are minimal because we only needed to tweak existing endpoints:

- `POST /realtime/publish/tee?channel={runId}`: Stream data to the IS, which ultimately should stream back to the client.
- `GET /v1/realtime/sse?token={realtimeJwt}`: Stream data sent to the other endpoint. The client uses this.

## Out of scope

These are features that we are not implementing right now.

- **Solving the late-joiner problem**. If the client joins after the DE has already started streaming to the IS, then tough luck.
- **Streaming outside of steps**. If a user streams outside of a `step.run` then they'll get undefined behavior. The only exception is when the DE has 0 total steps (that's OK).
- **Bidirectional streaming**. The client cannot stream back: it's only a consumer.

## Glossary

- **Client**: What sent the initial request to the DE. This is typically a browser, but could be anything that can send an HTTP request.
- **Durable Endpoint (DE)**: A special type of HTTP endpoint that allows users to use Inngest step methods within it.
- **Inngest Server (IS)**: The Inngest backend (Dev Server for local dev, Cloud for production).
