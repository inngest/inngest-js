# Execution architecture

## Lazy ops

Most opcodes without a local handler (`Sleep`, `WaitForEvent`, etc.) suspend the run. The SDK ships the opcode, the backend schedules the work, then the backend re-invokes the function with the result memoized in state. The opcode *is* the suspension.

Lazy ops (`StepOpCode.DeferAdd`) are fire-and-forget. User code keeps executing in the same run, so the op has no natural moment to ship. We resolve the user's `await` eagerly and park the op in `state.pendingLazyOps` until the next wire message carries it (checkpoint or response).

`defer()` must work anywhere in a handler: top-level, inside `step.run()`, and in any combination. Routing through the core loop handles the top-level case fine but deadlocks inside `step.run()`, since the outer step already holds the loop. Buffering handles both cases uniformly and lets consecutive calls batch into a single ship for free.

The buffer drains onto whichever wire message comes next: an outbound checkpoint request (async-checkpointing mode) or the response the SDK returns to the executor (sync mode). In async-checkpointing mode, we force a dedicated checkpoint call *before* `RunComplete`, since the backend finalizes on `RunComplete` and drops anything riding in the same batch.

Lazy ops bypass `state.steps` and the step middleware pipeline entirely. They aren't user-addressable as steps (no handler, no memoization, no awaitable result), so step hooks like `transformStepInput` / `wrapStep` / `onStepStart` have nothing to do with them. The engine's step handler short-circuits at the top: `isLazyOp(opts, opId)` returns true → hash the ID, push the op, return. Replay ops are filtered by `priorDefers[hashedId]`, sent by the executor in the request payload.

The `LazyOps` class (`lazyOps.ts`) is just a buffer: `push(op)` appends, `drain()` takes and clears, `has()` peeks. The engine owns op construction and shipping. The async `function-resolved` / `function-rejected` / `steps-found` handlers route their final response through `attachLazyOps`, which drains the buffer and bundles ops alongside the terminal `RunComplete` / `StepFailed` / `StepError` op (converting a terminal result into `steps-found` when ops are buffered). The remaining drain sites (`checkpoint()` and `maybeReturnNewSteps`) drain directly because they ship raw `OutgoingOp[]`, not an `ExecutionResult`. Sync-mode terminal rejection and the `checkpoint()` API-failure fallback still don't go through `attachLazyOps`; see the Todo in `defer.md`.

## Memo ops

`step.memo(id, value)` reuses the lazy op buffer for a `StepRun` op that carries data. The engine runs it in-process through the normal step path (`executeStep`, then `resumeStepWithResult`), so middleware and JSON serialization behave as they do for a checkpointed `step.run`, and the user's `await` resolves without stopping the run. The step is never reported as found; `memoizeStep` buffers its op instead.

Inngest treats more than one non-lazy op in a message as parallel steps, so memo ops cannot ride with other ops. `flushMemos` runs before every checkpoint handler in the core loop and ships buffered memos on their own: as a `steps-found` response in async mode, or as a checkpoint in the checkpointing modes. Whatever was found alongside the memo is found again when the run continues, now with the memo in state. `drain()` never returns memo ops, so a memo that finishes after the flush waits for the next one instead of riding with another op.
