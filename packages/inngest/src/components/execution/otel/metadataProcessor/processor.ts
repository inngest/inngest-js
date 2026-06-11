import { type Context, type Span, trace } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import { debugPrefix } from "../consts.ts";
import { extractAIMetadata } from "./libExtractors/index.ts";
import type { AIMetadataValues } from "./metadata.ts";

const aiMetadataDebug = Debug(`${debugPrefix}:AIMetadataSpanProcessor`);

type SpanContext = {
  onMetadata?: AIMetadataHandler;
  rootSpanId: string;
};

interface AIMetadataHandler {
  (values: AIMetadataValues): boolean;
}

export class InngestAIMetadataSpanProcessor implements SpanProcessor {
  /**
   * Tracks root spans and descendants by span ID. A child span is tracked only
   * when its parent is already tracked, so lineage back to the declared
   * execution root is preserved incrementally as spans start. Each tracked span
   * points to the root context and metadata callback.
   */
  #spanContexts = new Map<string, SpanContext>();

  /**
   * Normal span end calls cleanupSpan(). Use FinalizationRegistry to
   * automatically remove state and root callbacks if a tracked span is
   * garbage-collected without ending.
   */
  #spanCleanup = new FinalizationRegistry<string>((spanId) => {
    this.cleanupSpanState(spanId);
  });

  /**
   * Called when the engine starts the `inngest.execution` root span, before
   * user steps run. This root span is the ownership boundary for this
   * processor.
   */
  declareStartingSpan(args: {
    onMetadata?: AIMetadataHandler;
    span: Span;
    runId: string;
    traceparent: string | undefined;
    tracestate: string | undefined;
  }): void {
    const rootSpanId = args.span.spanContext().spanId;
    this.trackSpan(args.span, {
      onMetadata: args.onMetadata,
      rootSpanId,
    });
  }

  /**
   * Lifecycle method shared with Extended Traces. AI metadata attribution is
   * handled by the execution callback, so this processor does not need step
   * lifecycle state.
   */
  declareStepExecution(
    _rootSpanId: string,
    _id: string,
    _index: number,
    _hashedStepId: string,
    _attempt: number,
  ): void {}

  /**
   * Lifecycle method shared with Extended Traces. No-op for AI metadata.
   */
  clearStepExecution(_rootSpanId: string): void {}

  /**
   * OTel hook called when any span starts. Track spans whose parent is already
   * owned by this processor.
   */
  onStart(span: Span, parentContext: Context): void {
    // Follow only spans whose parent is already tracked. This mirrors Extended
    // Traces and keeps unrelated process-level OTel spans out of metadata.
    const parentSpanId = trace.getSpanContext(parentContext)?.spanId;
    if (!parentSpanId) {
      return;
    }

    const parentSpanContext = this.#spanContexts.get(parentSpanId);
    if (!parentSpanContext) {
      return;
    }

    this.trackSpan(span, parentSpanContext);
  }

  /**
   * OTel hook called when any span ends. Extract AI metadata from tracked spans
   * and emit it through the callback for the owning execution root.
   */
  onEnd(span: ReadableSpan): void {
    const spanContext = this.#spanContexts.get(span.spanContext().spanId);

    try {
      if (!spanContext?.onMetadata) {
        return;
      }

      const values = extractAIMetadata(span);
      if (Object.keys(values).length === 0) {
        return;
      }

      const added = spanContext.onMetadata(values);
      if (!added) {
        aiMetadataDebug("failed to add AI metadata to checkpoint payload");
      }
    } finally {
      this.cleanupSpan(span);
    }
  }

  /**
   * Required OTel SpanProcessor method. No-op because metadata extraction does
   * not buffer or export spans.
   */
  async forceFlush(): Promise<void> {}

  /**
   * Required OTel SpanProcessor method. No-op because metadata extraction does
   * not own any exporter resources.
   */
  async shutdown(): Promise<void> {}

  /**
   * Marks a span as owned by this processor so child spans can be followed and
   * ended spans can be matched back to their execution root.
   */
  private trackSpan(span: Span, spanContext: SpanContext): void {
    const spanId = span.spanContext().spanId;
    this.#spanCleanup.register(span, spanId, span);
    this.#spanContexts.set(spanId, spanContext);
  }

  /**
   * Removes tracking state after a span ends and unregisters the GC fallback.
   */
  private cleanupSpan(span: ReadableSpan): void {
    const spanId = span.spanContext().spanId;
    this.#spanCleanup.unregister(span);
    this.cleanupSpanState(spanId);
  }

  /**
   * Removes span tracking state and releases the metadata callback when the
   * span is an execution root.
   */
  private cleanupSpanState(spanId: string): void {
    const spanContext = this.#spanContexts.get(spanId);
    if (spanContext?.rootSpanId === spanId) {
      delete spanContext.onMetadata;
    }

    this.#spanContexts.delete(spanId);
  }
}

export const aiMetadataSpanProcessor = new InngestAIMetadataSpanProcessor();
