# Loops and FSMs

A loop is a function with one state record per key.  Each input for a key is one run.  The run reads the state, runs steps, and writes the state back.  The server runs one input per key at a time.

An fsm is a loop that cannot subscribe to events.

## Defining a loop

```ts
import { createFSM, createLoop } from "inngest/experimental";

type State = {
  phase: "stable" | "canary";
  build: string;
};

const rollout = createFSM(
  inngest,
  {
    id: "connect-app",
    triggers: [
      { event: "compute/deploy.created" },
      { event: "compute/workload.terminated" },
    ],
    key: "event.data.app_id",
    tick: "30s",
    state: { phase: "stable", build: "" } as State,
  },
  async ({ event, input, state, step, loop }) => {
    if (event.name === "compute/deploy.created") {
      state.build = event.data.build_id;
      state.phase = "canary";
    }

    const health = await step.run("check", () => checkReplicas(input.key));
    if (health === "starting") {
      return loop.wake("recheck", "10s");
    }

    state.phase = "stable";
  },
);
```

`createLoop` and `createFSM` return a `LoopFunction`, a subclass of `InngestFunction`.  Pass it to `serve({ functions: [...] })` with the other functions.

They are pure functions and not methods on the client, like `createDefer`, because the API is experimental.

The options are the options of `inngest.createFunction` with these differences.

- `key` is required.  It is a CEL expression over the event that names the instance.
- `state` is required.  It is the state an instance has before its first commit.  It must be an object or an array.  Its type is the type of `ctx.state`, so cast it when the literal is narrower than the state, as in the example.
- `tick` is optional.  The server runs the instance again that long after a run for the key finishes.
- `idleTTL` is optional.  The server deletes an instance that commits no state for that long.
- `singleton`, `batchEvents`, `debounce`, and a concurrency limit with a `key` are rejected.  The server rejects them too.
- `onFailure` is not supported.

## The handler

| Field    | Content                                                                                 |
| -------- | --------------------------------------------------------------------------------------- |
| `state`  | The state of the instance.  Change it in place.                                         |
| `input`  | `kind` (`event`, `tick`, `wake`, `subscription`), `id`, `key`, and `version`.           |
| `event`  | The trigger event, or `inngest/loop.tick`, `inngest/loop.wake`, or a subscribed event.  |
| `loop`   | `wake`, `end`, and for a loop `subscribe` and `unsubscribe`.                            |
| `step`   | The step tools without `sleep`, `sleepUntil`, `waitForEvent`, and `waitForSignal`.      |

Rules.

- **State is changed, not returned.**  The handler returns nothing.  A returned value is dropped with a warning.  A handler that throws commits nothing.
- **Do not change state in `step.run()`.**  A memoized step does not run its callback again, so the change is lost on the next request of the run.  Assign the step result to the state in the handler body.
- **Block for calls, return for waits.**  `step.run()` and `step.invoke()` are fine.  A run that waits holds the key, so no other input for the key can run.  To wait, call `loop.wake()` or `loop.subscribe()` and return.  The step tools that wait fail the run with a `NonRetriableError`.
- **Narrow `event` before reading `event.data`.**  A tick and a wake carry only the key and the wake id.  `input.key` is the key for every kind of input.

The `loop` calls are collected during the run and sent once, when the handler returns.

- `loop.wake(id, after)` runs the instance again after the duration.  The last call in a run wins.
- `loop.end()` ends the instance.  The server deletes its state and timers.  A wake from the same run is dropped.  The next trigger event for the key starts a new instance.
- `loop.subscribe(id, { event, if, ttl })` and `loop.unsubscribe(id)` add and remove a subscription.  The last call for an id wins.  They fail the run in an fsm.
- A `loop` call inside `step.run()` fails the step, for the same reason as a state change there.

## Wire protocol

Sync.  The function config has a `loop` block, and the SDK sends `capabilities.loop = "v1"`.  The server rejects a `loop` block from an SDK without the capability.

```json
{ "loop": { "kind": "fsm", "key": "event.data.app_id", "tick": "30s", "idle_ttl": "1w" } }
```

Request.  A `loop` block next to `event` and `steps`.  The server sends it on every request of the run.  `state` is null until the first commit, and the SDK then uses a copy of the initial state.  A loop request without the block fails the run without retry.

```json
{ "loop": { "state": null, "version": 0, "key": "app_123", "input": { "kind": "event", "id": "" } } }
```

Response.  A run ends with one `LoopReturn` opcode in a 206.  `version` is the request's version, sent back unchanged.  The server commits the state only when the stored version did not move.

```json
[{ "op": "LoopReturn", "id": "<hash>", "name": "loop", "data": {
    "state": { "phase": "stable", "build": "b1" },
    "version": 0,
    "end": false,
    "wake": { "id": "recheck", "after": "10s" }
} }]
```

## In the engine

`LoopRun` in `loop.ts` holds the state and the collected `loop` calls of one request.  The engine creates one when the function is a `LoopFunction` and the request runs its main handler.

- `createFnArg` adds `state`, `input`, and `loop` to the context.
- The step handler rejects the opcodes in `loopRejectedOps`.
- The `function-resolved` handler returns `steps-found` with one `LoopReturn` in place of a plain 200.  The server fails a loop run that ends without one.
- The server does not accept a `LoopReturn` in a checkpoint.  With checkpointing, the steps that are not checkpointed yet go in the same response, before the `LoopReturn`.  The server saves them and then commits the state.
- Every other response is the same as for a normal function.  A step result, a planned step, or an error has no `LoopReturn`, and the server calls the SDK again or retries.
- A tick, a wake, and a subscribed event are not checked against the trigger schemas.

## Limits

- The server does not support subscriptions yet.  It fails a run whose `LoopReturn` has `subscribe` or `unsubscribe`.
- `defer()` is skipped with a logged error.  The server accepts only step outputs next to a `LoopReturn`.
- Middleware does not see the state on its way out.  `wrapFunctionHandler` gets `undefined` as the output, so the encryption middleware does not encrypt the state.
- The server caps the state at 512KB.  A larger state fails the run without retry.

## Tests

- Unit tests are in `src/components/LoopFunction.test.ts`.
- Integration tests are in `src/test/integration/loop/`.  They are skipped unless `INNGEST_TEST_LOOPS` is set, because they need a Dev Server that runs loops.  Start that Dev Server on port 8288 first.  The test harness uses a Dev Server that already listens there.
