import { type Context, type Span, trace } from "@opentelemetry/api";
import type {
  ReadableSpan,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import {
  type AIMetadata,
  extractAIMetadataFromAttributes,
} from "./aiExtractor.ts";
import { debugPrefix } from "./consts.ts";

const processorDevDebug = Debug(`${debugPrefix}:InngestMetadataSpanProcessor`);

/**
 * Receives {@link AIMetadata} extracted from a span the moment it ends.
 * Supplied by the engine; the engine owns all aggregation and
 * step-attribution of the pushed values.
 */
export type AIMetadataSink = (metadata: AIMetadata) => void;

/**
 * Resolve the currently-registered global OTel tracer provider, unwrapping
 * the `ProxyTracerProvider` wrapper that `trace.getTracerProvider()` returns.
 * Returns `undefined` when no provider is registered.
 */
const getGlobalProvider = (): object | undefined => {
  const globalProvider = trace.getTracerProvider();
  if (!globalProvider) {
    return undefined;
  }

  const existingProvider =
    "getDelegate" in globalProvider &&
    typeof globalProvider.getDelegate === "function"
      ? globalProvider.getDelegate()
      : globalProvider;

  return existingProvider ?? undefined;
};

/**
 * Attempts to add the given span processor to the given OTel provider.
 * Returns `true` if the processor was attached, `false` if the provider could
 * not be extended.
 *
 * It handles both OTel SDK v1 (`addSpanProcessor()`) and v2 (internal
 * `_spanProcessors` array).
 *
 * This intentionally duplicates the attach logic inside `extendProvider`
 * (`util.ts`) to avoid imports with instrumentation side effects.
 */
const attachToProvider = (
  provider: object,
  processor: SpanProcessor,
): boolean => {
  // OTel SDK v1 exposes addSpanProcessor() on BasicTracerProvider.
  if (
    "addSpanProcessor" in provider &&
    typeof (provider as { addSpanProcessor?: unknown }).addSpanProcessor ===
      "function"
  ) {
    (
      provider as unknown as {
        addSpanProcessor: (p: SpanProcessor) => void;
      }
    ).addSpanProcessor(processor);
    return true;
  }

  // OTel SDK v2 removed addSpanProcessor() — span processors are constructor-only.
  // No public API exists to add processors post-construction (OTel issue #5299),
  // so push into the internal _spanProcessors array.
  // These fields are TypeScript `private` (not #private), so accessible at runtime.
  const spanProcessors = getInternalSpanProcessors(provider);
  if (spanProcessors) {
    spanProcessors.push(processor);
    return true;
  }

  return false;
};

/**
 * Extract the internal span processors array from a BasicTracerProvider.
 * Returns the mutable array if accessible, undefined otherwise.
 *
 * BasicTracerProvider._activeSpanProcessor is a MultiSpanProcessor,
 * which holds a _spanProcessors: SpanProcessor[] array.
 * Both are TypeScript `private` (not ES #private), so accessible at runtime.
 *
 * Wrapped in try/catch because this accesses internal OTel fields that may
 * change — must never crash the host app.
 */
function getInternalSpanProcessors(provider: unknown): unknown[] | undefined {
  try {
    const active = (provider as Record<string, unknown>)?._activeSpanProcessor;
    if (typeof active !== "object" || active === null) return undefined;

    const arr = (active as Record<string, unknown>)._spanProcessors;
    return Array.isArray(arr) ? arr : undefined;
  } catch {
    return undefined;
  }
}

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
   * A map of tracked spans to their sink. The map is seeded at the
   * step's root by {@link declareStartingSpan} and propagated to descendants in
   * {@link onStart}.
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
   * Latches once this processor has been attached to a global OTel provider, so
   * {@link attach} can never push it into a provider's processor list twice
   * (which would double-process every span and double-count tokens).
   */
  #attached = false;

  /**
   * Idempotently attach this processor to the global OTel provider that already
   * exists, so it begins receiving span lifecycle events.
   */
  attach(): void {
    if (this.#attached) {
      return;
    }

    const provider = getGlobalProvider();
    if (!provider) {
      return;
    }

    if (attachToProvider(provider, this)) {
      this.#attached = true;
      processorDevDebug("attached to global OTel provider");
    }
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
    if (!this.#attached) {
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
    const { traceId, spanId } = span.spanContext();
    const key = spanSinkKey(traceId, spanId);

    this.#spanCleanup.register(span, key, span);
    this.#spanSinks.set(key, sink);
  }

  /**
   * Clean up references to a span that has ended (or been GC'd).
   */
  private cleanupSpan(span: Span): void {
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

      const aiMetadata = extractAIMetadataFromAttributes(span.attributes);
      if (Object.keys(aiMetadata).length === 0) {
        return;
      }

      sink(aiMetadata);
    } finally {
      this.cleanupSpan(span as unknown as Span);
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
