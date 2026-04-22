import { type OutgoingOp, StepMode } from "../../types.ts";
import type {
  FoundStep,
  MatchOpFn,
  StepToolOptions,
} from "../InngestStepTools.ts";

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
   * Whether the buffer has any ops waiting to ship.
   */
  has(): boolean {
    return this.buffer.length > 0;
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
   * Buffer a step as a lazy op. Returns the `OutgoingOp` so the caller can
   * also resume the user's step promise with it.
   */
  push(step: FoundStep): OutgoingOp {
    const op = {
      id: step.hashedId,
      op: step.op,
      name: step.name,
      displayName: step.displayName,
      opts: step.opts,
      userland: step.userland,
      data: null,
    };
    this.buffer.push(op);
    return op;
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
