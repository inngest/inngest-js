import { type OutgoingOp, StepMode } from "../../types.ts";
import type { MatchOpFn, StepToolOptions } from "../InngestStepTools.ts";

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
   * Record that an id has been observed in this execution without buffering
   * an op for it. Used to consume a `priorDefers` replay match so that
   * subsequent encounters of the same id surface as duplicates.
   */
  markSeen(id: string): void {
    this.pushedIds.add(id);
  }
}

/**
 * True when a step being registered is an opcode-only sync op (no local
 * handler, sync mode).
 */
export function isLazyOp(
  opts: StepToolOptions | undefined,
  opId: ReturnType<MatchOpFn>,
): boolean {
  return !opts?.fn && opId.mode === StepMode.Sync;
}
