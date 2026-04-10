# Goal

I want to implement a new "defer" feature. Here's a code example of the user-facing API:

```ts
inngest.createFunction(
  {
    id: "fn-1",
    onDefer: async ({ event, step }) => {
      // Is "hello"
      event.data.msg;

      await step.run("a", () => {
        console.log("a");
      });
    },
    triggers: { event: "event-1" },
  },
  async ({ defer, event, step }) => {
    const msg = await step.run("create-msg", () => {
      return "hello";
    });

    await step.run("defer-1", async () => {
      await defer({
        data: {
          msg,
        },
      });
    });
  }
);
```

# Implementation

In some ways this is similar to the `onFailure` option. Under the hood, a full Inngest function is created for the `onFailure` option. It's just triggered by the `inngest/function.failed` event (and a trigger expression), which is sent if the function fails.

A difference for `onDefer` would be that users explicitly trigger it via the `defer` function. To keep things simple to start, have `defer` just send a `deferred.start` event via the normal Event API. Then that event triggers the `onDefer` function.

# Decisions

- **Event name**: `deferred.start` — no `inngest/` prefix to keep things simple and use the normal Event API
- **Event payload**: `{ runId, fnSlug, data }` where `data` is the arbitrary user-supplied data
- **No `id` field**: `defer({ data })` only — no routing/dedup key for now
- **`defer` is a top-level arg**: Passed alongside `event` and `step` in the main function handler, NOT a method on `step` (because users need to call it inside `step.run`, and steps can't nest)
- **Fire and forget**: `await defer()` just confirms the event was sent; it does not wait for the deferred function to complete
- **Must be called inside `step.run`**: Ensures memoization so it isn't called multiple times across retries/replays
- **Multiple calls allowed**: Each `defer()` call (in separate steps) sends a separate event and triggers a separate `onDefer` execution
- **`onDefer` is a full Inngest function**: Like `onFailure`, it's synced to Inngest with full `step` capabilities
- **Trigger expression**: Filters by `fnSlug` so the deferred function only fires for its parent function
- **`data` is untyped**: No generic/type parameter connecting `defer()`'s data to `onDefer`'s `event.data` yet
- **No server-side changes**: Purely SDK-side for now

# Out of scope

- `inngest/` event prefix (will need eventually)
- Routing by ID (multiple `onDefer` handlers per function)
- Type safety between `defer()` data and `onDefer` event data
- Server-side (Go) changes
- `step.defer()` convenience wrapper