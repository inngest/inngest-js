import { type OutgoingOp, StepOpCode } from "../../types.ts";

/**
 * Buffer for opcode-only sync ops (e.g. `DeferAdd`). These ops need to be
 * buffered until the next outbound wire message (e.g. checkpointing a
 * `step.run`).
 *
 * The engine owns shipping. This helper owns the buffer.
 */
export class LazyOps {
  private buffer: OutgoingOp[] = [];

  // Tracks every id pushed during this execution, including those already
  // drained. `buffer` alone can't answer "have we seen this id?" once a
  // checkpoint ships its contents, so duplicates that straddle a drain would
  // otherwise slip through.
  private pushedIds: Set<string> = new Set();

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
   * Buffer an op for later shipment.
   */
  push(op: OutgoingOp): void {
    this.buffer.push(op);
    this.pushedIds.add(op.id);
  }

  /**
   * Remove a still-buffered op by hashed id, returning whether it was found.
   * `pushedIds` is untouched, so a later push of the same id still surfaces
   * as a duplicate.
   */
  remove(id: string): boolean {
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
   * `hasId()` relies on (every buffered id is tracked) for any caller.
   */
  restore(ops: OutgoingOp[]): void {
    if (ops.length === 0) {
      return;
    }
    this.buffer = [...ops, ...this.buffer];
    for (const op of ops) {
      this.pushedIds.add(op.id);
    }
  }

  /**
   * Record that an id has been observed in this execution without buffering
   * an op for it. Used to consume a `priorDefers` replay match so that
   * subsequent encounters of the same id surface as duplicates.
   */
  markSeen(id: string): void {
    this.pushedIds.add(id);
  }
}

/**
 * Drop any `DeferAdd` whose `DeferAbort` is in the same outbound batch. The
 * executor processes a batch's ops concurrently, so a co-batched pair can
 * race and the abort can land first and error. The abort still ships: the
 * add may have already landed via a checkpoint whose failure was only
 * client-visible (see `restore()`), so "the add never shipped" is not
 * knowable locally — and an abort whose add truly never shipped is a
 * tolerated no-op on every backend ingestion path.
 */
export function sanitizeOutgoingOps(ops: OutgoingOp[]): OutgoingOp[] {
  const abortedTargets = new Set<string>();
  for (const op of ops) {
    if (op.op === StepOpCode.DeferAbort) {
      const target = op.opts?.target_hashed_id;
      if (typeof target === "string") {
        abortedTargets.add(target);
      }
    }
  }
  if (abortedTargets.size === 0) {
    return ops;
  }

  return ops.filter(
    (op) => !(op.op === StepOpCode.DeferAdd && abortedTargets.has(op.id)),
  );
}
