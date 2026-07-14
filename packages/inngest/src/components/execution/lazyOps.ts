import { type OutgoingOp, StepOpCode } from "../../types.ts";

/**
 * Buffer for opcode-only sync ops (e.g. `DeferAdd`). These ops need to be
 * buffered until the next outbound wire message (e.g. checkpointing a
 * `step.run`).
 *
 * The engine owns op construction, hashing, logging, and shipping. This
 * helper owns the buffer and every id-identity decision via `register` and
 * `abort`: deciding whether an op is pushed, a duplicate, a replay-skip,
 * already-aborted, or not-abortable. It enforces the invariant never both
 * a `DeferAdd` and the `DeferAbort` targeting it (a co-batched pair can race
 * in the executor since batches process concurrently, so the abort wins —
 * an abort whose add never shipped is a tolerated backend no-op, while "the
 * add never shipped" is not knowable locally; see `restore()`).
 */
export class LazyOps {
  private buffer: OutgoingOp[] = [];

  // Tracks every id pushed during this execution, including those already
  // drained. `buffer` alone can't answer "have we seen this id?" once a
  // checkpoint ships its contents, so duplicates that straddle a drain would
  // otherwise slip through.
  private pushedIds: Set<string> = new Set();

  // Defer IDs aborted during this execution. Used to prevent buffering the
  // same abort twice.
  private abortedDefers: Set<string> = new Set();

  constructor(
    private readonly priorDefers: Record<string, { abortable?: boolean }> = {},
  ) {}

  /**
   * Number of ops waiting to ship.
   */
  get length(): number {
    return this.buffer.length;
  }

  /**
   * Whether an op with this hashed id has been pushed in this execution
   * (whether or not it has since been drained).
   */
  hasId(id: string): boolean {
    return this.pushedIds.has(id);
  }

  /**
   * Take ownership of buffered ops and clear the buffer. Callers ship them on
   * whichever wire message comes next.
   */
  drain(): OutgoingOp[] {
    if (this.buffer.length === 0) {
      return [];
    }
    const ops = this.buffer;
    this.buffer = [];
    return ops;
  }

  /**
   * Buffer an op for later shipment, upholding the add/abort invariant.
   */
  push(op: OutgoingOp): void {
    this.buffer.push(op);
    this.pushedIds.add(op.id);
    this.dropAbortedAdds();
  }

  /**
   * Buffer a fully-built lazy op, deciding its fate by id:
   * `"duplicate"` if this id was already pushed during this execution (defer
   * IDs must be unique within a run; the caller warns so the user can spot
   * the bug), `"replay-skip"` if the id shipped in a prior execution (marked
   * seen so a later call with the same id surfaces as a real duplicate),
   * otherwise `"pushed"`.
   */
  register(op: OutgoingOp): "pushed" | "duplicate" | "replay-skip" {
    if (this.pushedIds.has(op.id)) {
      return "duplicate";
    }
    if (this.priorDefers[op.id]) {
      this.markSeen(op.id);
      return "replay-skip";
    }
    this.push(op);
    return "pushed";
  }

  /**
   * Buffer a `DeferAbort` targeting a previously registered defer.
   * `"already-aborted"` if this target was aborted earlier in this
   * execution. A still-buffered add is cancelled locally, but the abort
   * ships regardless: the executor can dispatch a request with a stale
   * `defers` map, so "the add never shipped" is not knowable locally, and
   * unknown-target aborts are tolerated by the backend. If the add is no
   * longer buffered and a prior execution marked it unabortable, returns
   * `"not-abortable"` without buffering.
   */
  abort(
    targetHashedId: string,
    abortOp: OutgoingOp,
  ): "aborted" | "already-aborted" | "not-abortable" {
    if (this.abortedDefers.has(targetHashedId)) {
      return "already-aborted";
    }
    if (
      !this.remove(targetHashedId) &&
      this.priorDefers[targetHashedId]?.abortable === false
    ) {
      return "not-abortable";
    }
    this.abortedDefers.add(targetHashedId);
    this.push(abortOp);
    return "aborted";
  }

  /**
   * Remove a still-buffered op by hashed id, returning whether it was found.
   * `pushedIds` is untouched, so a later push of the same id still surfaces
   * as a duplicate.
   */
  private remove(id: string): boolean {
    const index = this.buffer.findIndex((op) => op.id === id);
    if (index === -1) {
      return false;
    }
    this.buffer.splice(index, 1);
    return true;
  }

  /**
   * Put previously drained ops back at the front of the buffer so they ship
   * on the next outbound message. Used when the message carrying a drain
   * fails to send. Re-registers ids in `pushedIds` — a no-op for ops that
   * came from this instance's own `drain()`, but it preserves the invariant
   * `hasId()` relies on (every buffered id is tracked) for any caller. An
   * add whose abort was pushed while the drain was in flight is dropped.
   */
  restore(ops: OutgoingOp[]): void {
    if (ops.length === 0) {
      return;
    }
    this.buffer = [...ops, ...this.buffer];
    for (const op of ops) {
      this.pushedIds.add(op.id);
    }
    this.dropAbortedAdds();
  }

  /**
   * Record that an id has been observed in this execution without buffering
   * an op for it. Used internally to mark a `priorDefers` replay match so
   * that subsequent encounters of the same id surface as duplicates.
   */
  private markSeen(id: string): void {
    this.pushedIds.add(id);
  }

  /**
   * Drop any buffered `DeferAdd` whose `DeferAbort` is also buffered.
   * `pushedIds` is untouched.
   */
  private dropAbortedAdds(): void {
    const abortedTargets = new Set<string>();
    for (const op of this.buffer) {
      if (op.op === StepOpCode.DeferAbort) {
        const target = op.opts?.target_hashed_id;
        if (typeof target === "string") {
          abortedTargets.add(target);
        }
      }
    }
    if (abortedTargets.size === 0) {
      return;
    }

    this.buffer = this.buffer.filter(
      (op) => !(op.op === StepOpCode.DeferAdd && abortedTargets.has(op.id)),
    );
  }
}
