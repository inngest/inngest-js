# Goal

Implement a "defer" feature that lets a function fire off independent work with typed data. Here's the user-facing API:

```ts
import { createDefer } from "inngest/experimental";

const inngest = new Inngest({ id: "my-app" });

inngest.createFunction(
  {
    id: "fn-1",
    onDefer: {
      "send-email": createDefer(
        inngest,
        {
          schema: z.object({ to: z.string(), body: z.string() }),
          concurrency: { limit: 5 },
        },
        async ({ event, step }) => {
          event.data.to; // string
          await step.run("send", () => { ... });
        },
      ),
      "process-payment": createDefer(
        inngest,
        { schema: z.object({ amount: z.number() }) },
        async ({ event, step }) => {
          event.data.amount; // number
        },
      ),
    },
    triggers: { event: "order/placed" },
  },
  async ({ defer }) => {
    defer["send-email"]("send", { to: "a@b.com", body: "hi" });
    defer["process-payment"]("charge", { amount: 100 });
  },
);
```

# Implementation

Each `createDefer(client, { id, ... }, handler)` call creates exactly one Inngest function, regardless of how many parent functions attach it via `onDefer`. The `defer` call emits a `DeferAdd` opcode carrying `{ companion_id, input }`; the backend saves the defer against the run and, once the parent run finalizes, emits an `inngest/deferred.start` event that triggers the corresponding defer function. Defer functions are not passed to `serve()` — the SDK's comm handler implicitly collects every defer function referenced by at least one registered parent's `onDefer` map, deduping by function ID.

# Decisions

## Execution

Opcode-driven (e.g. `DeferAdd`). This requires a new pattern: opcode without a step. Because there isn't a step, we can't do things like control flow interruption. To solve this, we're introducing a new "lazy ops" pattern.

Lazy ops are named after their defining behavior: they're lazily reported. We buffer them until the next time we report (HTTP response or outgoing checkpoint request).

Deferred functions are triggered by a new `inngest/deferred.start` event. This event is sent from the backend. The event includes the user-specified input (passed to `defer.{alias}(id, input)`) and some metadata (in the `_inngest` field).

## Call semantics

`defer` methods emit a `DeferAdd` opcode. It's fire-and-forget: execution continues passed the `defer` call while the opcode is buffered.

The available methods on `defer` are the same as the `onDefer` keys.

Can be called inside or outside of `step.run()`.

## Inngest functions

A deferred function is a full Inngest function. It's created by a different function (`createDefer()` vs. `createFunction()`), but we still create an Inngest function for it.

A single deferred function can be "linked" to many parent functions. The deferred function will still be 1 Inngest function in the backend, but each linked parent function can trigger it.

## `createDefer`

Similar call signature to `createFunction()`, but with some differences:
- Remove `triggers`. The trigger is implicit (`inngest/deferred.start` filtered to the function's own ID).
- Add `schema` (optional). This defines the shape (runtime and/or static) of the data passed to the deferred function. In a normal Inngest function, this happens in the `triggers` field, but that field doesn't exist for `createDefer()`.
- Remove `onFailure`. We may add it later.
- The `event` object in the handler always has the name `inngest/deferred.start`. Its data type is controlled by the `schema` field.

`createDefer()` is a pure function instead of an `Inngest` client method for 2 reasons:
1. We don't want to commit to a signature for `createDefer()` yet.
2. We aren't sure if a client method would cause circular dependencies if we add an `onDefer` field to the client.

## Registration

The user does not pass a deferred function to their `serve()` function like they would for a normal Inngest function. Instead, deferred functions are implicitly synced if they're linked to at least 1 parent function.

Note that removing all of a deferred function's links will cause it to be removed from the backend.

# Type safety

Each `onDefer` entry accepts an optional `schema` field (`StandardSchemaV1`). The schema is the single source of truth, flowing to both the `defer()` call site and the handler's `event.data`.

Client-level middleware applies to deferred functions. This is necessary for things like dependency injection.

# Relationship to other features

- **`step.invoke(fn, { data })`**: Calls another function and waits for its result. Use when the caller needs the output.
- **`step.sendEvent()`**: Fires events that trigger any matching function. Generic, untyped relative to the receiver.
- **`defer.{alias}({ ... })`**: Fire-and-forget like `sendEvent`, but typed like `invoke`. Target is a named defer function (created via `createDefer`, potentially shared across parents). Use when you need a typed data contract with independent execution and its own retries/concurrency.

# Companion functions

`onFailure` and `onDefer` both execute independently with their own retries, concurrency, and step state. `onFailure` is still parent-owned (1:1 lifecycle hook); `onDefer` is a shared-reference pattern (many:many).

Shared properties:
- **Triggers are implicit.** The SDK determines how each is activated (`inngest/function.failed` for `onFailure`, `inngest/deferred.start` for `onDefer`). Users never wire triggers manually.
- **Input schemas describe the linkage.** A defer function's schema is the data contract between the parent's `defer()` call and the defer handler's `event.data`, not a normal trigger schema.

Where they diverge:
- **IDs.** `onFailure` IDs are derived from the parent (`{fnId}-failure`). `onDefer` IDs come from `createDefer({ id })` and are parent-independent — the same defer can be attached to many parents under different aliases.
- **Registration.** `onFailure` is expanded from its parent's config. Defer functions are collected implicitly by the comm handler from all parents' `onDefer` maps.

Future companions could include `onComplete` or `onCancel`. Each would follow the same pattern: a handler defined in the parent's config, triggered by an internal event, with its own execution context. The `handlerKind` discriminated union (see TODO) would extend to cover new kinds.

# Future work

Add way to cancel a `defer` method call.

Add way to immediately start the deferred function.

# TODO

- ~~**Nest user data in event payload.**~~ Resolved. The backend owns the payload shape (`{ _inngest, input }`) and the SDK unwraps `input` before the handler sees it; user keys can no longer collide with routing fields.
- ~~**Replace `isFailureHandler`/`isDeferHandler` booleans with a discriminated union.**~~ Done. `handlerKind: "main" | "failure" | "defer"` replaces both booleans in `InngestExecutionOptions`, `FnRegistryEntry`, and all callsites.
- ~~**Move defer routing to the opcode path.**~~ Done. `defer.{key}(id, data)` emits `StepOpCode.DeferAdd`; the backend publishes `inngest/deferred.start` at Finalize. The companion's trigger expression matches on `event.data._inngest.deferred_run.companion_id`.
- ~~**Remove `step.defer`.**~~ Done. The only entry point is the top-level `defer.{key}(idOrOptions, data)`, which is already memoized via the opcode path.
- **Remove `as any` in `createFunction`.** The cast bridges the user-facing `onDefer` config type to the internal `OnDeferConfig`. If one type changes without the other, the cast masks the mismatch. Align the types or add a narrowing helper to eliminate the cast.
- **Wire `OpcodeDeferCancel`.** Backend reserves it; SDK does not yet emit it. Needs a user-facing API (e.g. `defer.cancel`) and the matching opcode emission.
- **Re-add `onFailure` on defer functions.** `createDefer` currently omits `onFailure` from its options surface to keep the first pass narrow. Defer handlers can still fail — we just don't yet let users attach a per-defer failure handler. Adding it back means re-introducing the `TFailureHandler` generic with a ctx default built on `FailureEventArgs<DeferEvent<TSchema>>`.

## Testing

```sh
// Lint and format
pnpm -C packages/inngest exec biome check --fix

// Run onDefer integration tests
(export DEV_SERVER_ENABLED=0 && pnpm -C packages/inngest test:integration src/test/integration/onDefer.test.ts)
```
