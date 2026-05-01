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

  /**
   * Number of ops waiting to ship.
   */
  get length(): number {
    return this.buffer.length;
  }

  /**
   * Whether the buffer already contains an op with the given hashed id.
   */
  hasId(id: string): boolean {
    return this.buffer.some((op) => op.id === id);
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
