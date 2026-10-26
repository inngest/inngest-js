import { type OutgoingOp, StepMode, StepOpCode } from "../../types.ts";
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
   * Take ownership of buffered ops, except memo ops, and clear them from the
   * buffer. Callers ship them on whichever wire message comes next.
   */
  drain(): OutgoingOp[] {
    return this.take((op) => op.op !== StepOpCode.StepRun);
  }

  /**
   * Take only the memo ops (`step.memo()` results, which are `StepRun` ops
   * that carry data). Inngest treats more than one non-lazy op in a message
   * as parallel steps, so memo ops must ship on their own and `drain()` never
   * returns them.
   */
  drainMemos(): OutgoingOp[] {
    return this.take((op) => op.op === StepOpCode.StepRun);
  }

  private take(match: (op: OutgoingOp) => boolean): OutgoingOp[] {
    const taken = this.buffer.filter(match);
    this.buffer = this.buffer.filter((op) => !match(op));

    return taken;
  }

  /**
   * Buffer an op for later shipment.
   */
  push(op: OutgoingOp): void {
    if (op.op === StepOpCode.DeferAbort) {
      // If there's a matching DeferAdd op, remove it. We don't want to report
      // the same defer with DeferAdd and DeferAbort in the same request.
      this.buffer = this.buffer.filter((buffered) => {
        return !(
          buffered.op === StepOpCode.DeferAdd &&
          buffered.id === op.opts?.target_hashed_id
        );
      });
    }

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
