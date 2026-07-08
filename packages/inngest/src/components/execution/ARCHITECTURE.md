# Execution architecture

## Lazy ops

Most opcodes without a local handler (`Sleep`, `WaitForEvent`, etc.) suspend the run. The SDK ships the opcode, the backend schedules the work, then the backend re-invokes the function with the result memoized in state. The opcode *is* the suspension.

Lazy ops (`StepOpCode.DeferAdd`) are fire-and-forget. User code keeps executing in the same run, so the op has no natural moment to ship. We resolve the user's `await` eagerly and park the op in `state.lazyOps` until the next wire message carries it (checkpoint or response).

`defer()` must work anywhere in a handler: top-level, inside `step.run()`, and in any combination. Routing through the core loop handles the top-level case fine but deadlocks inside `step.run()`, since the outer step already holds the loop. Buffering handles both cases uniformly and lets consecutive calls batch into a single ship for free.

The buffer drains onto whichever wire message comes next: an outbound checkpoint request (async-checkpointing mode) or the response the SDK returns to the executor (sync mode). In async-checkpointing mode, we force a dedicated checkpoint call *before* `RunComplete`, since the backend finalizes on `RunComplete` and drops anything riding in the same batch.

Lazy ops bypass `state.steps` and the step middleware pipeline entirely. They aren't user-addressable as steps (no handler, no memoization, no awaitable result), so step hooks like `transformStepInput` / `wrapStep` / `onStepStart` have nothing to do with them. `defer()` doesn't route through the engine's step handler at all: it calls `registerLazyOp` directly, which hashes the ID and buffers the op synchronously. Replay ops are filtered by `priorDefers[hashedId]`, sent by the executor in the request payload.

The `LazyOps` class (`lazyOps.ts`) is just a buffer: `push(op)` appends, `drain()` takes and clears, `remove(id)` cancels a still-buffered op, `restore(ops)` puts a failed drain back at the front. The engine owns op construction and shipping. The async `function-resolved` / `function-rejected` / `steps-found` handlers route their final response through `attachLazyOps`, which drains the buffer and bundles ops alongside the terminal `RunComplete` / `RunError` op (converting a terminal result into `steps-found` when ops are buffered). The remaining drain sites (`checkpoint()` and `maybeReturnNewSteps`) drain directly because they ship raw `OutgoingOp[]`, not an `ExecutionResult`. `checkpoint()` restores its drain on API failure so the ops ride the fallback response or a later message instead of being lost. Sync-mode terminal rejection still doesn't go through `attachLazyOps`; see the Todo in `defer.md`.

Every assembled batch passes through `sanitizeOutgoingOps`, which drops a `DeferAdd` whose `DeferAbort` lands in the same message — the executor processes a batch concurrently, so a co-batched pair can race. The abort still ships: the add may have landed via a checkpoint whose failure was only client-visible, and an abort with no matching add is a tolerated backend no-op.
