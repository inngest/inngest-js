# Goal

Implement a "defer" feature that lets a function fire off independent work with typed data. Here's the user-facing API:

```ts
const inngest = new Inngest({ id: "my-app" });

inngest.createFunction(
  {
    id: "fn-1",
    onDefer: {
      "send-email": inngest.createDefer({
        schema: z.object({ to: z.string(), body: z.string() }),
        concurrency: { limit: 5 },
        handler: async ({ event, step }) => {
          event.data.to; // string
          await step.run("send", () => { ... });
        },
      }),
      "process-payment": inngest.createDefer({
        schema: z.object({ amount: z.number() }),
        handler: async ({ event, step }) => {
          event.data.amount; // number
        },
      }),
    },
    triggers: { event: "order/placed" },
  },
  async ({ defer, step }) => {
    await step.run("send", async () => {
      await defer["send-email"]({ to: "a@b.com", body: "hi" });
    });

    await step.run("charge", async () => {
      await defer["process-payment"]({ amount: 100 });
    });
  },
);
```

# Implementation

Similar to the `onFailure` option. Under the hood, a full Inngest function is created for each `onDefer` entry. The `defer` call sends a `deferred.start` event via the normal Event API, which triggers the corresponding companion function.

# Decisions

- **Event name**: `deferred.start` (no `inngest/` prefix; uses the normal Event API)
- **Event payload**: `{ runId, fnSlug, deferId, ...data }` where user data is spread flat alongside system fields
- **`step.defer` is a memoized step**: `step.defer.{key}(stepId, data)` wraps the defer send in a step, so it's safe across retries. Preferred for most use cases.
- **`defer` is a top-level arg**: Passed alongside `event` and `step` in the main handler. Not memoized. The send happens every time the code runs, including retries. Useful when called inside an existing `step.run` or when the caller intentionally wants to send on every attempt.
- **Fire and forget**: `await defer.process(...)` / `await step.defer.process(...)` confirms the event was sent; it does not wait for the deferred function to complete
- **Multiple named entries**: `onDefer` is an object map. Each key is a stable identifier that becomes part of the generated function ID (`{fnId}-defer-{key}`)
- **`defer` mirrors `onDefer` shape**: Define as an object, use as an object (`defer["send-email"]({ to: "..." })`)
- **Keys are durable IDs**: Renaming a key changes the generated function ID
- **`client.createDefer()`**: A helper method on the Inngest client that captures schema types and middleware context. Returns a branded result consumed by `onDefer`
- **`onDefer` is a full Inngest function**: Like `onFailure`, each entry is synced to Inngest with full `step` capabilities
- **Trigger expression**: Each companion filters by `fnSlug` and `deferId` so it only fires for its parent
- **No server-side changes**: Purely SDK-side for now

# Type safety

Each `onDefer` entry accepts an optional `schema` field (`StandardSchemaV1`). The schema is the single source of truth, flowing to both the `defer()` call site and the handler's `event.data`.

`client.createDefer()` captures the schema type in a branded `DeferHandlerResult<TSchema>` with a required `schema` property. `createFunction` captures the full `onDefer` config via a `const` generic (`TOnDefer`) and extracts per-entry schemas to type the `defer` methods. This avoids reverse-mapped-type inference (which fails when `schema` is absent) by capturing the whole config directly.

When `schema` is omitted, `event.data` and the corresponding `defer` method both default to `any`.

`client.createDefer()` includes client-level middleware context extensions (e.g. `db` from dependency injection) in the handler's type. The standalone `createDefer()` in triggers.ts does not have access to middleware types.

## Reused infrastructure

- `StandardSchemaV1` from `@standard-schema/spec`
- `AssertNoTransform` guard from `triggers.ts`

# Relationship to other features

- **`step.invoke(fn, { data })`**: Calls another function and waits for its result. Use when the caller needs the output.
- **`step.sendEvent()`**: Fires events that trigger any matching function. Generic, untyped relative to the receiver.
- **`defer.process({ ... })`**: Fire-and-forget like `sendEvent`, but typed like `invoke`. The target is a companion function, not standalone. Use when you need a typed data contract with independent execution and its own retries/concurrency.
- **`onFailure`**: The other companion function. Fires automatically on failure (lifecycle hook). `onDefer` fires explicitly (task spawning). Both generate hidden Inngest functions under the hood.

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

# Open questions

- **Should function-level middleware flow to companions?** Client-level middleware (`new Inngest({ middleware: [...] })`) flows to `onDefer` handlers via `client.createDefer()`. But function-level middleware (the `middleware` option on `createFunction`) does not. Should it? `onFailure` has the same question. If yes, `createDefer` would need access to the function-level middleware type, which it currently doesn't have since it's called before `createFunction`.
- **`onFailure` / `onDefer` API consistency.** `onFailure` takes an inline handler. `onDefer` requires `client.createDefer()`. The inconsistency is justified (`createDefer` solves type inference problems), but could confuse users. Should `onFailure` also get a `client.createFailureHandler()` for consistency?

# TODO

- **Nest user data in event payload.** User schema data is currently spread flat into `event.data` alongside system fields (`runId`, `fnSlug`, `deferId`). A user schema with a `runId` or `deferId` field would silently collide. Nest user data under `event.data.data` to match the original spec and prevent collisions.
- ~~**Replace `isFailureHandler`/`isDeferHandler` booleans with a discriminated union.**~~ Done. `handlerKind: "main" | "failure" | "defer"` replaces both booleans in `InngestExecutionOptions`, `FnRegistryEntry`, and all callsites.
- **Remove `as any` in `createFunction`.** The cast bridges the user-facing `onDefer` config type to the internal `OnDeferConfig`. If one type changes without the other, the cast masks the mismatch. Align the types or add a narrowing helper to eliminate the cast.
