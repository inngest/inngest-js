import { type Context, type Span, trace } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import type { OTelSetup } from "../../../proto/src/components/sdkFeatureObservations/protobuf/feature_observations.ts";
import { type AIMetadata, extractAIMetadataFromSpan } from "./aiExtractor.ts";
import { debugPrefix } from "./consts.ts";
import { attemptProviderExtension } from "./provider.ts";

const processorDevDebug = Debug(`${debugPrefix}:InngestMetadataSpanProcessor`);

/**
 * Receives {@link AIMetadata} extracted from a span the moment it ends.
 * Supplied by the engine; the engine owns all aggregation and
 * step-attribution of the pushed values.
 */
export type AIMetadataSink = (metadata: AIMetadata) => void;

/**
 * Builds the `#spanSinks` key for a span. Span IDs are only guaranteed unique
 * within a single trace, so spans are keyed by trace ID + span ID to avoid
 * cross-trace collisions.
 */
const spanSinkKey = (traceId: string, spanId: string): string =>
  `${traceId}:${spanId}`;

/**
 * A read-only OTel span processor that is independent of the Extended Traces
 * processor (`InngestSpanProcessor`).
 *
 * It tracks which spans belong to an Inngest step (seeded by
 * {@link declareStartingSpan} and passed from parent to child in `onStart`).
 *
 * When a tracked span ends, it extracts {@link AIMetadata} from the span's
 * attributes and pushes it to the span's {@link AIMetadataSink}.
 */
export class InngestMetadataSpanProcessor implements SpanProcessor {
  /**
   * A map of tracked spans to their sink.
   *
   * We use traceId:spanID as the key, which uniquely identifies each span. See
   * {@link spanSinkKey}
   *
   * The engine seeds the map during {@link declareStartingSpan} with the root
   * span and its sink.
   *
   * During onStart, the processor looks up the span's parent's sink and then
   * records the span as also using that sink. If the parent is not found, then
   * the span is not descended from a root step span, and therefore does not
   * need to have a sink.
   *
   * All spans with the same root span that started the step will share the
   * same sink.
   */
  #spanSinks = new Map<string, AIMetadataSink>();

  /**
   * A registry used to clean up items from `#spanSinks` when spans fall out of
   * reference without ending. Avoids leaking entries (and the engine sink
   * closures they reference) for spans that are never ended and are GC'd.
   */
  #spanCleanup = new FinalizationRegistry<string>((key) => {
    if (key) {
      this.#spanSinks.delete(key);
    }
  });

  /**
   * Stores the most recent provider setup attempt. Once `spanProcessorAdded` is
   * true, {@link attach} can never push this processor into a provider's
   * processor list twice (which would double-process every span and
   * double-count tokens).
   */
  #attachSetup: OTelSetup | undefined;

  /**
   * Idempotently attach this processor to the global OTel provider that already
   * exists, so it begins receiving span lifecycle events.
   */
  attach(): OTelSetup {
    if (this.#attachSetup?.spanProcessorAdded) {
      return this.#attachSetup;
    }

    const setup = attemptProviderExtension({ processor: this });
    this.#attachSetup = setup;
    if (setup.spanProcessorAdded) {
      processorDevDebug("attached to global OTel provider");
    }

    return setup;
  }

  /**
   * Declare the step's root span. Seeds tracking so that the root and all of
   * its descendants share the same AIMetadata sink.
   */
  public declareStartingSpan({
    span,
    traceparent,
    onAIMetadata,
  }: {
    span: Span;
    traceparent: string | undefined;
    onAIMetadata: AIMetadataSink;
  }): void {
    // If this processor is not attached to a  provider, we don't need to
    // declare starting spans.
    if (!this.#attachSetup?.spanProcessorAdded) {
      return;
    }

    // If we don't have a traceparent, then this isn't a step the Executor is
    // tracking, so we don't track it either.
    if (!traceparent) {
      return processorDevDebug(
        "no traceparent found for span",
        span.spanContext().spanId,
        "so skipping it",
      );
    }

    this.trackSpan(span, onAIMetadata);
  }

  /**
   * Mark a span as tracked, recording its step's sink and registering it for
   * cleanup.
   *
   * Read-only: unlike the Extended Traces processor, no attributes
   * are stamped on the span.
   */
  private trackSpan(span: Span, sink: AIMetadataSink): void {
    // OTel does not call span processors when a span is not recording, so an
    // entry for it would never be cleared by onEnd.
    if (!span.isRecording()) {
      return;
    }

    const { traceId, spanId } = span.spanContext();
    const key = spanSinkKey(traceId, spanId);

    this.#spanCleanup.register(span, key, span);
    this.#spanSinks.set(key, sink);
  }

  /**
   * Clean up references to a span that has ended (or been GC'd).
   */
  private cleanupSpan(span: ReadableSpan): void {
    const { traceId, spanId } = span.spanContext();
    this.#spanCleanup.unregister(span);
    this.#spanSinks.delete(spanSinkKey(traceId, spanId));
  }

  /**
   * Track children of spans we already care about, so the whole subtree under a
   * declared root is captured.
   */
  onStart(span: Span, parentContext: Context): void {
    const parentSpanId = trace.getSpanContext(parentContext)?.spanId;

    if (!parentSpanId) {
      return;
    }

    // A child span always shares its parent's trace ID, so the parent's key
    // can be built from the child's own span context.
    const sink = this.#spanSinks.get(
      spanSinkKey(span.spanContext().traceId, parentSpanId),
    );
    if (!sink) {
      return;
    }

    this.trackSpan(span, sink);
  }

  /**
   * On end, extract any AI metadata from the span's attributes and push it to
   * its sink, then clean up the span's tracking entry.
   */
  onEnd(span: ReadableSpan): void {
    const { traceId, spanId } = span.spanContext();

    try {
      const sink = this.#spanSinks.get(spanSinkKey(traceId, spanId));
      if (!sink) {
        return;
      }

      const aiMetadata = extractAIMetadataFromSpan(span);
      if (Object.keys(aiMetadata).length === 0) {
        return;
      }

      sink(aiMetadata);
    } finally {
      this.cleanupSpan(span);
    }
  }

  // Nothing to flush or shut down: this processor is read-only and has no
  // exporter.
  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

/**
 * The process-wide metadata span processor instance.
 */
export const metadataSpanProcessor = new InngestMetadataSpanProcessor();
