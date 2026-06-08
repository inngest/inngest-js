import type { Span } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import type { InngestRunSpanProcessor } from "./access.ts";
import { debugPrefix, TraceStateKey } from "./consts.ts";

const baseDevDebug = Debug(`${debugPrefix}:InngestSpanProcessorBase`);

/**
 * A block of information about an execution, propagated from a run's root span
 * down to every descendant so that ending spans can be tied back to their run.
 */
export type ParentState = {
  traceparent: string;
  runId: string;
  appId: string | undefined;
  functionId: string | undefined;
  traceRef: string | undefined;
  rootSpanId: string;
};

/**
 * The shared run/span tracking for all Inngest span processors.
 *
 * It maintains the mapping from each tracked span to its run root
 * (`#traceParents`), seeded by {@link declareStartingSpan} and propagated to
 * descendants in {@link onStart}, and looked up in {@link onEnd}. This base is
 * deliberately **passive**: it never mutates spans and never exports. Subclasses
 * add their behaviour via three hooks:
 *
 * - {@link shouldTrackChild} — gate which children get tracked (e.g. extended
 *   traces' between-steps filter).
 * - {@link onSpanTracked} — react to a span being tracked (e.g. extended traces
 *   stamps attributes here; the metadata processor does nothing, staying
 *   read-only).
 * - {@link onSpanEnding} — react to a tracked span ending, given its
 *   `rootSpanId` (e.g. export, or accumulate/log). Called before the span's
 *   tracking entry is cleaned up.
 */
export abstract class InngestSpanProcessorBase
  implements SpanProcessor, InngestRunSpanProcessor
{
  /**
   * A map of span IDs to their parent state, which includes the run root that
   * the span belongs to.
   */
  #traceParents = new Map<string, ParentState>();

  /**
   * A registry used to clean up items from `#traceParents` when spans fall out
   * of reference without ending. Avoids leaking entries for spans that are
   * never ended and are GC'd.
   */
  #spanCleanup = new FinalizationRegistry<string>((spanId) => {
    if (spanId) {
      this.#traceParents.delete(spanId);
    }
  });

  // --- hooks --------------------------------------------------------------

  /**
   * Decide whether a child of an already-tracked span should be tracked.
   * Defaults to `true`; override to filter (e.g. infrastructure spans between
   * steps in checkpointing mode).
   */
  protected shouldTrackChild(_parentState: ParentState): boolean {
    return true;
  }

  /**
   * Called when a span is added to tracking. Base does nothing (passive).
   * Override to react — e.g. stamp attributes for export.
   */
  protected onSpanTracked(
    _span: Span,
    _parentState: ParentState,
    _isRoot: boolean,
  ): void {}

  /**
   * Called when a tracked span ends, given the run `rootSpanId` it belongs to.
   * Runs before the span's tracking entry is removed, so subclasses can rely on
   * the root being resolvable. Base does nothing.
   */
  protected onSpanEnding(_span: ReadableSpan, _rootSpanId: string): void {}

  // --- run/span tracking --------------------------------------------------

  /**
   * Declare the run's root span. Seeds tracking so that the root and all of its
   * descendants are tied back to this `rootSpanId`.
   */
  public declareStartingSpan({
    span,
    runId,
    traceparent,
    tracestate,
  }: {
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void {
    if (!traceparent) {
      return baseDevDebug(
        "no traceparent found for span",
        span.spanContext().spanId,
        "so skipping it",
      );
    }

    let appId: string | undefined;
    let functionId: string | undefined;
    let traceRef: string | undefined;

    if (tracestate) {
      try {
        const entries = Object.fromEntries(
          tracestate.split(",").map((kv) => kv.split("=") as [string, string]),
        );

        appId = entries[TraceStateKey.AppId];
        functionId = entries[TraceStateKey.FunctionId];
        traceRef = entries[TraceStateKey.TraceRef];
      } catch (err) {
        baseDevDebug(
          "failed to parse tracestate",
          tracestate,
          "skipping;",
          err,
        );
      }
    }

    this.trackSpan(
      {
        appId,
        functionId,
        runId,
        traceparent,
        traceRef,
        rootSpanId: span.spanContext().spanId,
      },
      span,
      true,
    );
  }

  /**
   * Mark a span as tracked, recording its run root and registering it for
   * cleanup, then invoke the {@link onSpanTracked} hook.
   */
  private trackSpan(
    parentState: ParentState,
    span: Span,
    isRoot = false,
  ): void {
    const spanId = span.spanContext().spanId;

    this.#spanCleanup.register(span, spanId, span);
    this.#traceParents.set(spanId, parentState);

    this.onSpanTracked(span, parentState, isRoot);
  }

  /**
   * Clean up references to a span that has ended (or been GC'd).
   */
  private cleanupSpan(span: Span): void {
    const spanId = span.spanContext().spanId;
    this.#spanCleanup.unregister(span);
    this.#traceParents.delete(spanId);
  }

  /**
   * Track children of spans we already care about, so the whole subtree under a
   * declared root is captured.
   */
  onStart(span: Span): void {
    // Support both OTel SDK v2.x (parentSpanContext.spanId) and v1.x
    // (parentSpanId as a plain string) since users may have either version.
    const parentSpanId =
      (span as unknown as ReadableSpan).parentSpanContext?.spanId ??
      (span as unknown as { parentSpanId?: string }).parentSpanId;

    if (!parentSpanId) {
      return;
    }

    const parentState = this.#traceParents.get(parentSpanId);
    if (!parentState) {
      return;
    }

    if (!this.shouldTrackChild(parentState)) {
      return;
    }

    this.trackSpan(parentState, span);
  }

  /**
   * On end, resolve the span's run root and hand it to {@link onSpanEnding}
   * before cleaning up its tracking entry.
   */
  onEnd(span: ReadableSpan): void {
    const spanId = span.spanContext().spanId;

    try {
      const parentState = this.#traceParents.get(spanId);
      if (parentState) {
        this.onSpanEnding(span, parentState.rootSpanId);
      }
    } finally {
      this.cleanupSpan(span as unknown as Span);
    }
  }

  abstract forceFlush(): Promise<void>;
  abstract shutdown(): Promise<void>;
}
