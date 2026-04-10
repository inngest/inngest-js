# Goal

I want to implement a new "defer" feature. Here's a code example of the user-facing API:

```ts
inngest.createFunction(
  {
    id: "fn-1",
    onDefer: {
      schema: z.object({ msg: z.string() }),
      concurrency: { limit: 5 },
      handler: async ({ event, step }) => {
        // Is "hello"
        event.data.data.msg;

        await step.run("a", () => {
          console.log("a");
        });
      },
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
- **No server-side changes**: Purely SDK-side for now

# Type safety

`onDefer` accepts an optional `schema` field (`StandardSchemaV1`) that provides type safety between `defer()` data and `onDefer`'s `event.data.data`. The schema is the single source of truth for the data type, flowing to both sides.

## API

```ts
inngest.createFunction(
  {
    id: "fn-1",
    onDefer: {
      schema: z.object({ msg: z.string() }),
      concurrency: { limit: 5 },
      handler: async ({ event, step }) => {
        event.data.data.msg; // string — inferred from schema
      },
    },
    triggers: [{ event: "event-1" }],
  },
  async ({ defer, event, step }) => {
    await defer({ data: { msg: "hello" } }); // typed + validated at runtime
  }
);
```

## Type flow

1. `onDefer.schema` is typed as `StandardSchemaV1<TDeferData>` (optional)
2. `createFunction` adds a generic `TDeferSchema` inferred from `onDefer.schema`
3. `TDeferData` extracted via `StandardSchemaV1<infer T>` (reuses existing `ExtractSchemaData`)
4. `TDeferData` flows to:
   - `onDefer.handler` context: `event.data.data: TDeferData`
   - Main handler context: `defer: (opts: { data: TDeferData }) => Promise<void>`
5. No schema → `TDeferData` defaults to `Record<string, unknown>`
6. `AssertNoTransform` guard applies (defer input type must match event.data.data output type)
7. `onDefer` config also accepts flow control fields: `concurrency`, `retries`, `throttle`, etc.

## Reused infrastructure

- `StandardSchemaV1` from `@standard-schema/spec`
- `staticSchema<T>()` from `inngest` for type-only safety
- `ExtractSchemaData` from `triggers.ts`
- `AssertNoTransform` guard from `triggers.ts`

# Multiple `onDefer` handlers

`onDefer` accepts a named object map of handler configs. Each key is a stable identifier that becomes part of the generated function ID (`{fnId}-defer-{key}`).

The main handler receives a single `defer()` function. Callers pass `deferId` to route to the correct handler. TypeScript narrows `data` based on the `deferId` literal.

## API

```ts
inngest.createFunction(
  {
    id: "fn-1",
    onDefer: {
      "send-email": {
        schema: z.object({ to: z.string(), body: z.string() }),
        handler: async ({ event, step }) => {
          event.data.data.to; // string — inferred from schema
        },
      },
      "process-payment": {
        schema: z.object({ amount: z.number() }),
        concurrency: { limit: 1 },
        handler: async ({ event, step }) => {
          event.data.data.amount; // number — inferred from schema
        },
      },
    },
    triggers: [{ event: "order/placed" }],
  },
  async ({ defer, step }) => {
    await step.run("send", async () => {
      await defer({ deferId: "send-email", data: { to: "a@b.com", body: "hi" } });
    });

    await step.run("charge", async () => {
      await defer({ deferId: "process-payment", data: { amount: 100 } });
    });
  },
);
```

## Type flow

1. `onDefer` is a `const` object map; TS captures a **schema map** generic (`TOnDeferSchemas`) that maps each key to its `StandardSchemaV1` type
2. A mapped type (`DeferEntryInput`) provides contextual typing for each handler based on its sibling `schema` — each entry is independently typed via reverse mapped type inference
3. `defer` arg type is a discriminated union over `deferId` built from the schema map:
   ```ts
   type DeferArg =
     | { deferId: "send-email"; data: { to: string; body: string } }
     | { deferId: "process-payment"; data: { amount: number } };
   ```
4. Each handler's `event.data.data` is typed from its own `schema`
5. No schema → `data` defaults to `Record<string, unknown>` for that handler

## Event routing

- `deferred.start` event payload includes a `deferId` field: `{ runId, fnSlug, deferId, data }`
- Each generated function triggers on: `event.data.fnSlug == '{fnId}' && event.data.deferId == '{key}'`

## Decisions

- **Object map (not array)**: Each property is independently typed, enabling per-handler contextual typing without helper functions or `as const` — arrays of objects with callbacks break TS `const` generic inference
- **`deferId` inside the options object**: Single arg, consistent with SDK conventions, enables discriminated union narrowing natively
- **Single `defer()` function**: Not `defer.name()` — avoids dual shapes and keeps the API surface simple
- **`deferId` is always required**: Even with one handler. Keeps the API consistent and leaves room for optional `deferId` later if desired
- **Keys are durable IDs**: Renaming a key changes the generated function ID — document this clearly

# Out of scope

- `inngest/` event prefix (will need eventually)
- Server-side (Go) changes
- `step.defer()` convenience wrapper