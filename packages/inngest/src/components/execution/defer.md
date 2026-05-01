# Deferred functions/runs

Fire-and-forget independent work with typed data.

## When to use

| Tool                            | Returns to caller?  | Independent execution?    |
| ------------------------------- | ------------------- | ------------------------- |
| `step.invoke(fn, { data })`     | Yes (awaits result) | No (caller blocks)        |
| `step.sendEvent(...)`           | No                  | Yes (any matching fn)     |
| `defer(id, { function, data })` | No                  | Yes (single typed target) |

Use `defer` when you need a typed contract with a specific target and don't need its result. A concrete use case is an LLM scorer.

## Defining a defer function

```ts
import { createDefer } from "inngest/experimental";
import { z } from "zod";

const sendEmail = createDefer(
  inngest,
  {
    id: "send-email",
    schema: z.object({ to: z.string(), body: z.string() }),
    concurrency: { limit: 5 },
  },
  async ({ event, step }) => {
    event.data.to; // typed from `schema`
    event.data.body;
  },
);
```

A defer function is a real Inngest function with its own retries, concurrency, and step state. It's triggered implicitly by `inngest/deferred.schedule` filtered to its own ID, so users don't wire triggers manually. Pass it to `serve({ functions: [...] })` alongside regular functions.

`createDefer` is a pure function rather than a method on the Inngest client because we don't yet want to commit to a client-method signature; we may move it later.

`createDefer` mirrors `inngest.createFunction` with three differences:

- The client is the first positional arg.
- `triggers` is not accepted.
- `schema` describes the payload that callers send via `defer(...)`.
- No `onFailure` option. We may add it later.
- No `batchEvents` option. We may add it later.

## Calling defer

`defer` is always available on the handler context:

```ts
const orderPlaced = inngest.createFunction(
  { id: "order-placed", triggers: { event: "order/placed" } },
  async ({ defer }) => {
    defer("send", { function: sendEmail, data: { to: "a@b.com", body: "hi" } });
  },
);
```

The first argument is a unique ID, similar to what we do for steps. However, unlike steps, `defer` IDs must be unique within a run: we don't do the same "add implicit index to dedupe" trick that we do for steps. We can't do that because `defer` can be run in `step.run`, so the implicit index would change when reentering the function.

The `data` type is inferred from `function.schema`. `defer` is sync and fire-and-forget: it returns `void` and execution continues immediately.

It also works inside `step.run()`:

```ts
await step.run("notify", async () => {
  defer("send", { function: sendEmail, data: { ... } });
});
```

## Schemas

`schema` is optional (`StandardSchemaV1`). When present, `data` is validated at the call site and again on the receiver side. The receiver-side check catches serialization round-trips that change the shape (e.g. `Date` becoming an ISO string). The same schema types `event.data` in the handler.

Call-site validation must be synchronous because `defer(...)` itself is sync; if the schema's `validate` returns a Promise, the SDK throws. Receiver-side validation is async, so async validators work there.

Without a schema, `data` falls back to `Record<string, any>`.

## Sharing across parents

A defer function is one Inngest function in the backend. Multiple parent functions can hold a reference to it and each call to `defer(...)` triggers an independent run.

## Implementation

`defer` emits a `DeferAdd` opcode. Because it's fire-and-forget, the op has no natural moment to ship; the SDK buffers it (a "lazy op") and ships it on the next outbound message: a checkpoint, a step result, or `RunComplete`. See `ARCHITECTURE.md` for the buffering rationale and drain sites.

The backend records each `DeferAdd` against the parent run as it arrives. The deferred run isn't started immediately: when the parent run finalizes, the backend emits one `inngest/deferred.schedule` event per recorded defer, and that event triggers the matching defer function.

On replay, the executor sends back a `defers` map of hashed step IDs it has already received. The SDK uses `priorDefers` to skip re-emitting them.

## Todo

- **Support async call-site validation** -- `defer()` itself must stay sync (fire-and-forget, no `await` at the call site), so we can't `await schema.validate(data)` inline. Maybe we can attach the pending validation promise to the buffered lazy op and await it at drain time, before the op is reported. A failure should reject the run the same way a sync validation failure does today.

- **Support `onFailure`** -- We may add it later.

- **Support `batchEvents`** -- We may add it later. We haven't decided if deferred runs should be restricted to a single parent run. To do that, we may need to implicitly add a key. We'll revisit this decision later.

- **Support aborting a `defer` call.** -- A `DeferAbort` opcode is reserved on the backend but the SDK doesn't yet emit it. Needs a user-facing API (e.g. `const { abort } = defer("id", { function, data })`) and the matching opcode emission.

- **Support starting a deferred run immediately.** -- Today the deferred run starts only when the parent run finalizes. We may want an opt-in path (e.g. `defer("id", { function, data }).now()`).
