# Execution architecture

## Lazy ops

Most opcodes without a local handler (`Sleep`, `WaitForEvent`, etc.) suspend the run. The SDK ships the opcode, the backend schedules the work, then the backend re-invokes the function with the result memoized in state. The opcode *is* the suspension.

Lazy ops (`StepOpCode.DeferAdd`) are fire-and-forget. User code keeps executing in the same run, so the op has no natural moment to ship. We resolve the user's `await` eagerly and park the op in `state.pendingLazyOps` until the next wire message carries it (checkpoint or response).

`defer()` must work anywhere in a handler: top-level, inside `step.run()`, and in any combination. Routing through the core loop handles the top-level case fine but deadlocks inside `step.run()`, since the outer step already holds the loop. Buffering handles both cases uniformly and lets consecutive calls batch into a single ship for free.

The buffer drains onto whichever wire message comes next: an outbound checkpoint request (async-checkpointing mode) or the response the SDK returns to the executor (sync mode). In async-checkpointing mode, we force a dedicated checkpoint call *before* `RunComplete`, since the backend finalizes on `RunComplete` and drops anything riding in the same batch.

The `LazyOps` class (`lazyOps.ts`) owns both construction and buffering: `push(step)` builds the op and buffers it, returning the op so callers can resume the user's step promise; `drain()` takes and clears, `has()` peeks. `isLazyOp(opts, opId)` detects opcode-only-sync steps. The engine owns shipping. Drain sites: `checkpoint()`, `maybeReturnNewSteps`, the `steps-found` handler, and the async `function-resolved` / `function-rejected` handlers.
