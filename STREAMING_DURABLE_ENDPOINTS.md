# Streaming Durable Endpoints: Design Decisions

## Problem

`experimentalTransformSyncResponse` calls `await res.clone().text()`, buffering the entire response before returning. A durable endpoint returning a streaming Response blocks until the stream finishes, then sends everything at once. Streaming is defeated.

## Goal

When all steps succeed synchronously and the function returns a streaming Response, stream it to the client in real time. No changes to user code — just import the updated SDK.

## Target Example

```typescript
export const POST = inngest.endpoint(async (req) => {
  const validated = await step.run("validate-request", async () => {
    return { prompt, model: "gpt-4o-mini", timestamp: Date.now() };
  });

  const stream = await openai.responses.create({
    model: validated.model,
    input: validated.prompt,
    stream: true,
  });

  return new Response(stream.toReadableStream());
});
```

The only difference from a vanilla (non-durable) streaming endpoint is `inngest.endpoint()` wrapping and `step.run()` calls. The streaming code is identical.

## Detection Strategy

The SDK detects streaming at the `Response.body` level: if the user's function returns a `Response` whose `body` is a `ReadableStream`, it's streaming. This is provider-agnostic — OpenAI, Anthropic, Google, Mistral, Cohere, Bedrock, or a hand-built stream all produce a standard `Response` with a `ReadableStream` body by the time they reach the SDK.

Every major LLM provider's streaming API implements `AsyncIterable`. Some (OpenAI, Anthropic) also provide `toReadableStream()` helpers. Others require a small conversion. But that's the user's concern — the SDK is downstream of the `Response` constructor and doesn't need to know what created the stream.

## Verified Assumptions

| Claim | Status |
|-------|--------|
| Response object survives execution engine → `transformOutput` → `handleSyncRequest` → `wrapHandler` → Next.js without serialization | Confirmed |
| `wrapHandler` doesn't touch the return value (only sets function `name`/`length`) | Confirmed |
| Pre-stream async (step fails → redirect → retry) works via existing `change-mode` path | Confirmed |
| Async retry path correctly buffers the stream via `experimentalTransformSyncResponse` | Confirmed |

## Decisions

### 1. Detect at `Response.body`, not at the provider level

**Not**: detect `AsyncIterable`, OpenAI `Stream`, or other provider-specific types.

By the time the SDK sees the return value, it's a standard `Response`. Check `response.body instanceof ReadableStream`. This works for every provider without adapters.

### 2. Call `transformOutput()`, then swap the data

**Not**: return a raw `{ type, data }` object from the checkpoint handler.

Returning directly bypasses `transformOutput` and `finished` middleware hooks. Logging, cleanup, encryption — all silently broken. The return type also requires `ctx` and `ops` fields that only `transformOutput` provides.

Instead: call `this.transformOutput({ data: checkpoint.data })` as normal, then replace the `data` field in the result with the tee'd streaming Response.

### 3. Checkpoint with retry, not fire-and-forget

**Not**: `void (async () => { await this.checkpoint(...) })()`.

If the checkpoint fails silently, Inngest never learns the run completed. It times out and retries. The user already received their stream, so now they get duplicate AI calls and duplicate side effects.

Instead: use `retryWithBackoff` (already used elsewhere in v2.ts) on the capture branch. Log errors if it ultimately fails. Accept that the response is not blocked on checkpoint success — the trade-off is latency vs. guaranteed delivery of the completion signal.

### 4. Apply middleware to the capture branch only

**Not**: tee before middleware, send raw data in the checkpoint.

`createResponse` is called with middleware-transformed data (e.g. encrypted by encryption middleware). The client needs the original stream. The checkpoint needs the transformed version.

Tee the original stream. Client gets one branch directly. Capture branch goes through middleware transformation before checkpointing.

### 5. Accept `tee()` memory trade-off

`tee()` doesn't reduce memory — both branches read from the same source, and the capture branch buffers the full content. What it buys is **latency**: the client sees first tokens immediately instead of waiting for the full stream.

For very large streams, incremental checkpointing could reduce memory. Out of scope for PoC.

### 6. Accept mid-stream failure as a known limitation

Mid-stream failures (OpenAI rate limit, network drop, OOM) result in: partial stream to client → connection close → checkpoint fails → Inngest retries → user already gone.

This is worse than the current buffered behavior for the failure case, but better for the success case (which is the vast majority). Document this. Consider adding a run ID to the SSE stream so clients can poll for results if the stream breaks.

### 7. Defer the async streaming path

When a step fails pre-stream and execution redirects to async, the retry buffers the full response through Inngest's infrastructure. The user gets a correct but non-streamed result.

True async streaming requires platform-side changes (Inngest Cloud/Dev Server forwarding SSE from the retry execution). Out of scope for PoC. The behavior degrades gracefully.

## Scope

| Scenario | PoC Behavior |
|----------|-------------|
| All steps succeed, function returns streaming Response | Streams in real time |
| Step fails before streaming starts | Redirects to async, buffered result (existing behavior) |
| Stream errors mid-flight | Partial stream + close, retry may occur |
| Async retry of a streaming endpoint | Buffered result via Inngest infrastructure |

## Files to Change

- `packages/inngest/src/components/execution/v2.ts` — sync `function-resolved` handler: detect streaming Response, tee, async checkpoint
- `packages/inngest/src/next.ts` — no changes expected (Response passthrough verified)
- `packages/inngest/src/components/InngestCommHandler.ts` — no changes expected (`handleSyncRequest` returns `data` directly)

## Open Questions

1. Should `transformOutput` middleware receive the streaming Response, or a marker indicating "this is streaming"? Middleware that tries to read `.data` as JSON will break.
2. What should the checkpoint contain for a streaming response? The full buffered body? A marker? Nothing?
3. Should we inject an Inngest run ID into the SSE stream header events so clients can recover from mid-stream failures?
