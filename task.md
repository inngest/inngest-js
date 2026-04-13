# Goal

A new "defer" feature that lets a running function schedule a separate handler to execute, with the ability to cancel the scheduled handler before it runs. `onDefer` is viable as an alternative to `onFailure` for non-catastrophic scenarios, because defers dispatch on both successful completion and terminal failure.

User-facing API:

```ts
inngest.createFunction(
  {
    id: "fn-1",
    onDefer: async ({ event, step }) => {
      event.data.msg; // "hello"
      await step.run("a", () => {
        console.log("a");
      });
    },
    triggers: { event: "event-1" },
  },
  async ({ defer, event, step }) => {
    const msg = await step.run("create-msg", () => "hello");

    const handle = await step.run("defer-1", async () => {
      return await defer({ data: { msg } });
    });

    if (event.data.skip) {
      await step.run("cancel-defer-1", async () => {
        return handle.cancel();
      });
    }
  }
);
```

# Implementation

Structurally similar to `onFailure`: a second synthetic Inngest function (`${fnId}-defer`) is synced, triggered by a `deferred.start` event filtered on the parent `fnSlug`.

Unlike `onFailure`, dispatch is driven by the SDK at end-of-run, not by a pre-existing event. The mechanics:

1. **`defer({ data })`** does NOT send an event. It generates a uuid and returns a handle `{ $$inngestDefer: true, uuid, data, cancel() }`. Called inside `step.run` so the marker is memoized as the step's output (functions strip during JSON round-trip, so the engine re-attaches `cancel` in a step.run post-processor).
2. **`handle.cancel()`** returns `{ $$inngestDeferCancel: true, uuid }`. User wraps it in a `step.run` for the same durability reason — the marker lives on the step's output.
3. **End-of-run flush**: when the main handler resolves (success) or fails terminally (retries exhausted or non-retriable), the engine scans step outputs for defer and cancel markers, computes live defers = `{uuids with defer}` − `{uuids with cancel}`, and batches one `deferred.start` event per live defer. Event id is `${runId}:${uuid}` so repeated flushes under checkpointing retries deduplicate at the platform level.
4. **Retry behavior**: flush only fires on terminal attempts. Intermediate retriable failures don't dispatch — the function may still succeed later.

# Decisions

- **Event name**: `deferred.start` — no `inngest/` prefix.
- **Event payload**: `{ runId, fn_slug, uuid, data }`. `uuid` identifies the specific defer within the parent run.
- **`defer` is a top-level arg**: Passed alongside `event` and `step` in the main handler. NOT a method on `step` (because users must call it inside `step.run` for memoization, and steps can't nest).
- **Must be called inside `step.run`**: The step.run's memoization is what makes the marker durable across replays.
- **`await defer()` returns a handle, not a dispatch confirmation**: Dispatch is deferred to end-of-run. This differs from prior event-API-based designs.
- **Per-handle cancel**: `handle.cancel()` cancels just that handle's defer. Other handles in the same run are unaffected.
- **Multiple calls allowed**: Each `defer()` call gets its own uuid, its own handle, its own cancel semantics, and its own dispatched event.
- **`onDefer` as a `onFailure` alternative**: Since flush fires on both successful completion and terminal failure, `onDefer` runs in both scenarios. Users who want failure-only behavior can branch on a field in `data`.
- **`onDefer` is a full Inngest function**: Synced to Inngest with full `step` capabilities.
- **Trigger expression**: Filters by `fn_slug` so the deferred function only fires for its parent function.
- **Flush idempotency**: `event.id = ${runId}:${uuid}` makes repeated flushes under checkpointing safe — platform dedupes.
- **`data` is untyped**: No generic/type parameter connecting `defer()`'s data to `onDefer`'s `event.data` yet.
- **No server-side changes**: Purely SDK-side.

# Out of scope

- `inngest/` event prefix (will need eventually).
- Routing by user-supplied ID (multiple `onDefer` handlers per function).
- Type safety between `defer()` data and `onDefer` event data.
- Server-side (Go) changes.
- `step.defer()` convenience wrapper.
- Mid-flight cancellation of a deferred run that has already started executing. Current design only cancels before the flush dispatches the event; once the deferred run is enqueued, it runs to completion. (A future extension could re-add a `cancelOn`-based mid-flight cancel if needed.)