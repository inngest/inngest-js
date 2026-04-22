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
    await defer["send-email"]("send", { to: "a@b.com", body: "hi" });
    await defer["process-payment"]("charge", { amount: 100 });
  },
);
```

# Implementation

Each `createDefer(client, { id, ... }, handler)` call creates exactly one Inngest function, regardless of how many parent functions attach it via `onDefer`. The `defer` call emits a `DeferAdd` opcode carrying `{ companion_id, input }`; the backend saves the defer against the run and, once the parent run finalizes, emits an `inngest/deferred.start` event that triggers the corresponding defer function. Defer functions are not passed to `serve()` — the SDK's comm handler implicitly collects every defer function referenced by at least one registered parent's `onDefer` map, deduping by function ID.

# Decisions

- **Opcode-driven, backend-routed**: `defer` emits `StepOpCode.DeferAdd` with `{ companion_id, input }`. The SDK no longer sends a `defer.start` event via the Event API; the backend records the defer in run state and publishes `inngest/deferred.start` at Finalize, keyed deterministically so retries don't double-trigger.
- **Event name (backend-emitted)**: `inngest/deferred.start`
- **Event payload (backend-emitted)**: `{ _inngest: { deferred_run: { companion_id }, parent_run: { fn_slug, run_id } }, input: <user data> }`. The SDK unwraps `event.data.input` before the companion handler runs so user code sees `event.data` shaped per the schema.
- **`defer` is the only entry point**: `defer.{key}(idOrOptions, data)` emits a `DeferAdd` opcode keyed by the user-provided step ID. Safe across retries via server-side step idempotency. Passed alongside `event` and `step` in the main handler; no `step.defer` equivalent.
- **Fire and forget**: `await defer.process(...)` resolves as soon as the SDK has queued the opcode for shipment; it does not wait for the deferred function to complete. The companion event is emitted after the parent run finalizes.
- **Lazy opcode shipment**: `DeferAdd` (and any future opcode-only sync op like `DeferCancel`) resolves the user's `await` eagerly and buffers the opcode for shipment with the next response — a checkpoint, a step result, or function completion. Consecutive defers batch into a single ship. In async-checkpointing mode, buffered ops flush via a dedicated checkpoint call before `RunComplete`, because the backend finalizes on `RunComplete` and emits companion events based on defers recorded prior to that point — same-batch shipment loses them. This shipment model is what makes `defer.process` safe to call inside `step.run` handlers: routing the opcode through the core loop would deadlock (outer step awaits defer; defer awaits the loop; loop is blocked on the outer step).
- **Shared, not owned**: `onDefer` is an object map of call-site aliases → defer function references (results of `createDefer`). The map key is *only* a call-site alias used as the property name on `defer.{alias}(...)`. The defer function's own `id` (passed to `createDefer`) is what becomes the synced function ID, so the same defer can be attached to N parents without duplicating infra.
- **`defer` mirrors `onDefer` shape**: Define as an object, use as an object (`defer["send-email"]("step-id", { to: "..." })`). The alias is local to each parent — two parents can attach the same defer under different aliases.
- **Aliases are not durable**: renaming an alias is safe; renaming a defer function's `id` (the argument to `createDefer`) changes the synced function ID.
- **Config (concurrency/retries) is shared**: `concurrency` and `retries` on a defer apply globally across every parent that attaches it. If you need per-caller tuning, create a separate defer function.
- **`createDefer(client, opts, handler)`**: A standalone helper exported from `inngest/experimental`. Takes the client as first arg (inferring middleware/schema context), config as second arg, and the handler as third (mirroring `createFunction(opts, handler)`). Returns a branded result consumed by `onDefer`. Kept off the client as a method while the API is experimental so we don't commit to a signature.
- **Each defer is a full Inngest function**: Synced with full `step` capabilities. Trigger is `inngest/deferred.start` with an expression matching its own function ID.
- **Not passed to `serve()`**: The comm handler walks every registered main function's `onDefer` map and transparently includes referenced defer functions in the sync payload, deduped by id. Remove every attachment and the defer silently drops from the app — worth being aware of.
- **Server-side support required**: Relies on `OpcodeDeferAdd` / `OpcodeDeferCancel` in the executor plus Finalize-time event emission. See `linell/exe-1622-add-deferred-run-opcode` in the `inngest` repo.

# Type safety

Each `onDefer` entry accepts an optional `schema` field (`StandardSchemaV1`). The schema is the single source of truth, flowing to both the `defer()` call site and the handler's `event.data`.

`createDefer(client, opts, handler)` captures the schema type in a branded `DeferHandlerResult<TSchema>` with a required `schema` property. `createFunction` captures the full `onDefer` config via a `const` generic (`TOnDefer`) and extracts per-entry schemas to type the `defer` methods. This avoids reverse-mapped-type inference (which fails when `schema` is absent) by capturing the whole config directly.

When `schema` is omitted, `event.data` and the corresponding `defer` method both default to `any`.

`createDefer(client, opts, handler)` includes client-level middleware context extensions (e.g. `db` from dependency injection) in the handler's type by inferring `TClientOpts` from the client argument.

## Reused infrastructure

- `StandardSchemaV1` from `@standard-schema/spec`
- `AssertNoTransform` guard from `triggers.ts`

# Relationship to other features

- **`step.invoke(fn, { data })`**: Calls another function and waits for its result. Use when the caller needs the output.
- **`step.sendEvent()`**: Fires events that trigger any matching function. Generic, untyped relative to the receiver.
- **`defer.{alias}({ ... })`**: Fire-and-forget like `sendEvent`, but typed like `invoke`. Target is a named defer function (created via `createDefer`, potentially shared across parents). Use when you need a typed data contract with independent execution and its own retries/concurrency.
- **`onFailure`**: Still 1:1 with its parent function — fires automatically on the parent's failure and is owned by that parent. `onDefer` is now many:many (shared defer functions). Both still generate Inngest functions under the hood; only `onDefer` decouples identity from the parent.

# Companion functions

`onFailure` and `onDefer` both execute independently with their own retries, concurrency, and step state. `onFailure` is still parent-owned (1:1 lifecycle hook); `onDefer` is now a shared-reference pattern (many:many task spawning).

Shared properties:
- **Triggers are implicit.** The SDK determines how each is activated (`inngest/function.failed` for `onFailure`, `inngest/deferred.start` for `onDefer`). Users never wire triggers manually.
- **Input schemas describe the linkage.** A defer function's schema is the data contract between the parent's `defer()` call and the defer handler's `event.data`, not a normal trigger schema.

Where they diverge:
- **IDs.** `onFailure` IDs are derived from the parent (`{fnId}-failure`). `onDefer` IDs come from `createDefer({ id })` and are parent-independent — the same defer can be attached to many parents under different aliases.
- **Registration.** `onFailure` is expanded from its parent's config. Defer functions are collected implicitly by the comm handler from all parents' `onDefer` maps.

Future companions could include `onComplete` or `onCancel`. Each would follow the same pattern: a handler defined in the parent's config, triggered by an internal event, with its own execution context. The `handlerKind` discriminated union (see TODO) would extend to cover new kinds.

# Out of scope

- `OpcodeDeferCancel` wiring on the SDK side (the opcode is reserved but the SDK does not yet emit it)

# Open questions

- **Should function-level middleware flow to companions?** Client-level middleware (`new Inngest({ middleware: [...] })`) flows to `onDefer` handlers via `client.createDefer()`. But function-level middleware (the `middleware` option on `createFunction`) does not. Should it? `onFailure` has the same question. If yes, `createDefer` would need access to the function-level middleware type, which it currently doesn't have since it's called before `createFunction`.
- **`onFailure` / `onDefer` API consistency.** `onFailure` takes an inline handler. `onDefer` requires `client.createDefer()`. The inconsistency is justified (`createDefer` solves type inference problems), but could confuse users. Should `onFailure` also get a `client.createFailureHandler()` for consistency?

# TODO

- ~~**Nest user data in event payload.**~~ Resolved. The backend owns the payload shape (`{ _inngest, input }`) and the SDK unwraps `input` before the handler sees it; user keys can no longer collide with routing fields.
- ~~**Replace `isFailureHandler`/`isDeferHandler` booleans with a discriminated union.**~~ Done. `handlerKind: "main" | "failure" | "defer"` replaces both booleans in `InngestExecutionOptions`, `FnRegistryEntry`, and all callsites.
- ~~**Move defer routing to the opcode path.**~~ Done. `defer.{key}(id, data)` emits `StepOpCode.DeferAdd`; the backend publishes `inngest/deferred.start` at Finalize. The companion's trigger expression matches on `event.data._inngest.deferred_run.companion_id`.
- ~~**Remove `step.defer`.**~~ Done. The only entry point is the top-level `defer.{key}(idOrOptions, data)`, which is already memoized via the opcode path.
- **Remove `as any` in `createFunction`.** The cast bridges the user-facing `onDefer` config type to the internal `OnDeferConfig`. If one type changes without the other, the cast masks the mismatch. Align the types or add a narrowing helper to eliminate the cast.
- **Wire `OpcodeDeferCancel`.** Backend reserves it; SDK does not yet emit it. Needs a user-facing API (e.g. `defer.cancel`) and the matching opcode emission.

## Testing

```sh
// Lint and format
pnpm -C packages/inngest exec biome check --fix

// Run onDefer integration tests
(export DEV_SERVER_ENABLED=0 && pnpm -C packages/inngest test:integration src/test/integration/onDefer.test.ts)
```
