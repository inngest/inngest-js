# Goal

Implement a "defer" feature that lets a function fire off independent work with typed data. Here's the user-facing API:

```ts
import { createDefer } from "inngest/experimental";

const inngest = new Inngest({ id: "my-app" });

const sendEmail = createDefer(
  inngest,
  {
    id: "send-email",
    schema: z.object({ to: z.string(), body: z.string() }),
    concurrency: { limit: 5 },
  },
  async ({ event, step }) => {
    event.data.to; // string
    await step.run("send", () => { ... });
  },
);

const processPayment = createDefer(
  inngest,
  { id: "process-payment", schema: z.object({ amount: z.number() }) },
  async ({ event, step }) => {
    event.data.amount; // number
  },
);

const orderPlaced = inngest.createFunction(
  { id: "fn-1", triggers: { event: "order/placed" } },
  async ({ defer }) => {
    defer("send", { function: sendEmail, data: { to: "a@b.com", body: "hi" } });
    defer("charge", { function: processPayment, data: { amount: 100 } });
  },
);

serve({ client: inngest, functions: [orderPlaced, sendEmail, processPayment] });
```

# Implementation

Each `createDefer(client, { id, ... }, handler)` call creates exactly one Inngest function. The `defer(stepId, { function, data })` call emits a `DeferAdd` opcode carrying `{ companion_id, input }`; the backend saves the defer against the run and, once the parent run finalizes, emits an `inngest/deferred.start` event that triggers the corresponding defer function. Defer functions are passed to `serve()` alongside regular functions — they're full Inngest functions that just happen to use an implicit trigger.

# Decisions

## Execution

Opcode-driven (e.g. `DeferAdd`). This requires a new pattern: opcode without a step. Because there isn't a step, we can't do things like control flow interruption. To solve this, we're introducing a new "lazy ops" pattern.

Lazy ops are named after their defining behavior: they're lazily reported. We buffer them until the next time we report (HTTP response or outgoing checkpoint request).

Deferred functions are triggered by a new `inngest/deferred.start` event. This event is sent from the backend. The event includes the user-specified input (passed to `defer.{alias}(id, input)`) and some metadata (in the `_inngest` field).

## Call semantics

`defer(stepId, { function, data })` emits a `DeferAdd` opcode. It's fire-and-forget: execution continues past the `defer` call while the opcode is buffered.

The `function` argument is the result of `createDefer(...)`. The `data` type is inferred from that function's schema.

Can be called inside or outside of `step.run()`.

## Inngest functions

A deferred function is a full Inngest function. It's created by a different function (`createDefer()` vs. `createFunction()`), but we still create an Inngest function for it.

A single deferred function can be referenced by many parent functions. The deferred function is still 1 Inngest function in the backend, and any function that holds a reference to it can call `defer(stepId, { function, data })` to trigger it.

## `createDefer`

Similar call signature to `createFunction()`, but with some differences:
- Remove `triggers`. The trigger is implicit (`inngest/deferred.start` filtered to the function's own ID).
- Add `schema` (optional). This defines the shape (runtime and/or static) of the data passed to the deferred function. In a normal Inngest function, this happens in the `triggers` field, but that field doesn't exist for `createDefer()`.
- Remove `onFailure`. We may add it later.
- The `event` object in the handler always has the name `inngest/deferred.start`. Its data type is controlled by the `schema` field.

`createDefer()` is a pure function instead of an `Inngest` client method to avoid committing to a client-method signature yet.

## Registration

Deferred functions are passed to `serve()` alongside regular functions. The comm handler detects them by their `deferMeta` and registers them with `handlerKind: "defer"`.

# Type safety

`createDefer` accepts an optional `schema` field (`StandardSchemaV1`). The schema is the single source of truth, flowing through the `DeferHandlerResult` brand to both the `defer(...)` call site (where it types the `data` argument) and the handler's `event.data`.

Client-level middleware applies to deferred functions. This is necessary for things like dependency injection.

# Relationship to other features

- **`step.invoke(fn, { data })`**: Calls another function and waits for its result. Use when the caller needs the output.
- **`step.sendEvent()`**: Fires events that trigger any matching function. Generic, untyped relative to the receiver.
- **`defer(stepId, { function, data })`**: Fire-and-forget like `sendEvent`, but typed like `invoke`. Target is a defer function (created via `createDefer`, potentially shared across parents). Use when you need a typed data contract with independent execution and its own retries/concurrency.

# Companion functions

`onFailure` and defer functions both execute independently with their own retries, concurrency, and step state. `onFailure` is parent-owned (1:1 lifecycle hook); a defer function is a standalone function that any caller can reference (many:many).

Shared properties:
- **Triggers are implicit.** The SDK determines how each is activated (`inngest/function.failed` for `onFailure`, `inngest/deferred.start` for defer). Users never wire triggers manually.
- **Input schemas describe the linkage.** A defer function's schema is the data contract between the caller's `defer()` call and the defer handler's `event.data`, not a normal trigger schema.

Where they diverge:
- **IDs.** `onFailure` IDs are derived from the parent (`{fnId}-failure`). Defer IDs come from `createDefer({ id })` and are parent-independent.
- **Registration.** `onFailure` is expanded from its parent's config. Defer functions are passed to `serve()` directly (the comm handler identifies them by `deferMeta` and registers with `handlerKind: "defer"`).

Future companions could include `onComplete` or `onCancel`. Each would follow the same pattern: triggered by an internal event, with its own execution context. The `handlerKind` discriminated union would extend to cover new kinds.

# Future work

Add way to cancel a `defer` method call.

Add way to immediately start the deferred function.

# TODO

- ~~**Nest user data in event payload.**~~ Resolved. The backend owns the payload shape (`{ _inngest, input }`) and the SDK unwraps `input` before the handler sees it; user keys can no longer collide with routing fields.
- ~~**Replace `isFailureHandler`/`isDeferHandler` booleans with a discriminated union.**~~ Done. `handlerKind: "main" | "failure" | "defer"` replaces both booleans in `InngestExecutionOptions`, `FnRegistryEntry`, and all callsites.
- ~~**Move defer routing to the opcode path.**~~ Done. `defer(stepId, { function, data })` emits `StepOpCode.DeferAdd`; the backend publishes `inngest/deferred.start` at Finalize. The companion's trigger expression matches on `event.data._inngest.fn_slug`.
- ~~**Remove `step.defer`.**~~ Done. The only entry point is the top-level `defer(idOrOptions, { function, data })`, which is already memoized via the opcode path.
- ~~**Remove `as any` in `createFunction`.**~~ Done. The `onDefer` config type was removed from `CreateFunctionInput`, eliminating the cast.
- ~~**Pass defer functions to `serve()` instead of collecting them implicitly.**~~ Done. `createDefer` returns a `DeferHandlerResult` that satisfies `InngestFunction.Like`, so users pass it to `serve({ functions: [...] })` alongside regular functions. The comm handler identifies defer functions by `deferMeta` and assigns `handlerKind: "defer"`.
- **Wire `OpcodeDeferCancel`.** Backend reserves it; SDK does not yet emit it. Needs a user-facing API (e.g. `defer.cancel`) and the matching opcode emission.
- **Re-add `onFailure` on defer functions.** `createDefer` currently omits `onFailure` from its options surface to keep the first pass narrow. Defer handlers can still fail — we just don't yet let users attach a per-defer failure handler. Adding it back means re-introducing the `TFailureHandler` generic with a ctx default built on `FailureEventArgs<DeferEvent<TSchema>>`.

## Testing

```sh
// Lint and format
pnpm -C packages/inngest exec biome check --fix

// Run onDefer integration tests
(export DEV_SERVER_ENABLED=0 && pnpm -C packages/inngest test:integration src/test/integration/defer.test.ts)
```
