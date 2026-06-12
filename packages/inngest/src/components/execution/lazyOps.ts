import { type OutgoingOp, StepMode } from "../../types.ts";
import type { MatchOpFn, StepToolOptions } from "../InngestStepTools.ts";

/**
 * Buffer for opcode-only sync ops (e.g. `DeferAdd`). These ops need to be
 * buffered until the next outbound wire message (e.g. checkpointing a
 * `step.run`).
 *
 * Entries are promises: `defer()` reserves membership synchronously, while
 * async preparation (schema validation + `transformDeferInput`) settles later.
 * `drain()` awaits the prepared ops.
 *
 * The engine owns shipping. This helper owns the buffer.
 */
export class LazyOps {
  private buffer: Promise<OutgoingOp | null>[] = [];

  // Tracks every id pushed during this execution, including those already
  // drained. `buffer` alone can't answer "have we seen this id?" once a
  // checkpoint ships its contents, so duplicates that straddle a drain would
  // otherwise slip through.
  private pushedIds: Set<string> = new Set();

  /**
   * Number of ops waiting to ship, including those still preparing.
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
   * Take ownership of buffered ops and clear the buffer, waiting for pending
   * entries to settle. Entries that resolve `null` are dropped.
   */
  async drain(): Promise<OutgoingOp[]> {
    if (this.buffer.length === 0) {
      return [];
    }
    const pending = this.buffer;
    this.buffer = [];
    const ops = await Promise.all(pending);
    return ops.filter((op): op is OutgoingOp => op !== null);
  }

  /**
   * Buffer an op for later shipment. Reserve the id synchronously so duplicate
   * detection does not depend on `ready` having settled. `ready` must never
   * reject; resolve `null` to skip.
   */
  push(id: string, ready: OutgoingOp | Promise<OutgoingOp | null>): void {
    this.buffer.push(Promise.resolve(ready));
    this.pushedIds.add(id);
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
