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

The main handler receives a `defer` object that mirrors the `onDefer` config shape. Each key is a typed method that sends the corresponding deferred event.

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
      await defer["send-email"]({ data: { to: "a@b.com", body: "hi" } });
    });

    await step.run("charge", async () => {
      await defer["process-payment"]({ data: { amount: 100 } });
    });
  },
);
```

## Type flow

1. `onDefer` is a `const` object map; TS captures a **schema map** generic (`TOnDeferSchemas`) that maps each key to its `StandardSchemaV1` type
2. A mapped type (`DeferEntryInput`) provides contextual typing for each handler based on its sibling `schema` — each entry is independently typed via reverse mapped type inference
3. `defer` is a mapped object mirroring the `onDefer` keys, where each key is a typed method:
   ```ts
   type Defer = {
     "send-email": (opts: { data: { to: string; body: string } }) => Promise<void>;
     "process-payment": (opts: { data: { amount: number } }) => Promise<void>;
   };
   ```
4. Each handler's `event.data.data` is typed from its own `schema`
5. No schema → `data` defaults to `Record<string, unknown>` for that handler

## Event routing

- `deferred.start` event payload includes a `deferId` field: `{ runId, fnSlug, deferId, data }`
- Each generated function triggers on: `event.data.fnSlug == '{fnId}' && event.data.deferId == '{key}'`

## Decisions

- **Object map (not array)**: Each property is independently typed, enabling per-handler contextual typing without helper functions or `as const` — arrays of objects with callbacks break TS `const` generic inference
- **`defer` mirrors `onDefer` shape**: Config and call-site use the same mental model — define as an object, use as an object (`defer["send-email"]({ data })`)
- **Keys are durable IDs**: Renaming a key changes the generated function ID — document this clearly

# Companion functions

`onFailure` and `onDefer` are both examples of an emerging pattern tentatively called "companion functions": full Inngest functions that are colocated with a parent function in `createFunction`'s options. They execute independently with their own retries, concurrency, and step state.

Companions differ from normal functions in a few ways:
- **Triggers are implicit.** The parent determines how the companion is activated (`inngest/function.failed` for `onFailure`, `deferred.start` for `onDefer`). Users never wire triggers manually.
- **IDs are derived from the parent.** The key name in the config becomes part of the generated function ID (`{fnId}-defer-{key}`, `{fnId}-failure`). No separate `id` option needed.
- **Input schemas belong to the relationship.** An `onDefer` handler's schema describes the data contract between the parent's `defer()` call and the companion's `event.data`. This is different from a normal function's trigger schema.

We considered making companions standalone `createFunction` calls linked together, but all three properties above push toward colocation. Standalone functions would need explicit trigger wiring, explicit IDs, and some way to attach schemas to the linkage rather than the trigger.

Future companions could include `onComplete` or `onCancel`. Each would follow the same pattern: a handler defined in the parent's config, triggered by an internal event, with its own execution context. The `handlerKind` discriminated union (see TODO) would extend to cover new kinds.

# Out of scope

- `inngest/` event prefix (will need eventually)
- Server-side (Go) changes
- `step.defer()` convenience wrapper

# TODO

- **Nest user data in event payload.** User schema data is currently spread flat into `event.data` alongside system fields (`runId`, `fnSlug`, `deferId`). A user schema with a `runId` or `deferId` field would silently collide. Nest user data under `event.data.data` to match the original spec and prevent collisions.
- **Add `step.defer`.** Currently `defer()` is a top-level context arg that works anywhere in the handler, but calling it outside a step means it re-sends on every retry/replay. Introduce `step.defer` as a convenience wrapper that wraps the send in a step automatically (memoized, safe across retries). Keep the top-level `defer` for use inside existing `step.run` calls.
- **Replace `isFailureHandler`/`isDeferHandler` booleans with a discriminated union.** Execution options use two independent booleans where both-true is representable but meaningless. A `handlerKind: "main" | "failure" | "defer"` union would make invalid states unrepresentable. This affects ~12 callsites across CommHandler, engine, and tests, so treat it as a separate refactor.
- **Remove `as any` in `createFunction`.** The cast bridges `DeferEntryInput` (user-facing, per-handler schema inference) to `OnDeferConfig` (internal, `Handler.Any`). If one type changes without the other, the cast masks the mismatch. Align the types or add a narrowing helper to eliminate the cast.
- **Fix type inference when `onDefer` entry omits `schema`.** When a handler has no `schema` field, `TOnDeferSchemas` fails to infer and `defer` doesn't appear on the handler context. Runtime works fine, only the types break. Root cause: TypeScript's reverse-mapped-type inference can't infer from an absent optional property. Attempted fixes: `NoInfer` on handler (doesn't help — no inference source remains), direct `const` capture of the full config (inference ordering between `options` and `handler` parameters prevents `TOnDefer` from being inferred). Likely needs a fundamentally different generic structure — possibly function overloads or a two-pass inference strategy.