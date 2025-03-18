import { type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  type IResource,
  detectResourcesSync,
  envDetectorSync,
  hostDetectorSync,
  osDetectorSync,
  processDetectorSync,
  serviceInstanceIdDetectorSync,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import { envKeys } from "../../../helpers/consts.js";
import { processEnv } from "../../../helpers/env.js";

const processorDebug = Debug("inngest:otel:InngestSpanProcessor");
let _resourceAttributes: IResource | undefined;

/**
 * TODO
 */
export class InngestSpanProcessor implements SpanProcessor {
  /**
   * TODO
   */
  #batcher: BatchSpanProcessor | undefined;

  /**
   * A set of spans used to track spans that we care about, so that we can
   * export them to the OTel endpoint.
   *
   * If a span falls out of reference, it will be removed from this set as we'll
   * never get a chance to export it or remove it anyway.
   */
  #spansToExport = new WeakSet<Span>();

  /**
   * TODO
   */
  #traceParents = new Map<string, string>();

  /**
   * A registry used to clean up items from the `traceParents` map when spans
   * fall out of reference. This is used to avoid memory leaks in the case where
   * a span is not exported, remains unended, and is left in memory before being
   * GC'd.
   */
  #spanCleanup = new FinalizationRegistry<string>((spanId) => {
    if (spanId) {
      this.#traceParents.delete(spanId);
    }
  });

  /**
   * TODO
   */
  public declareStartingSpan(traceparent: string, span: Span): void {
    // This is a span that we care about, so let's make sure it and its
    // children are exported.
    processorDebug.extend("declareStartingSpan")(
      "declaring:",
      span.spanContext().spanId,
      "for traceparent",
      traceparent
    );

    span.setAttributes(InngestSpanProcessor.resourceAttributes.attributes);
    this.trackSpan(span, traceparent);
  }

  /**
   * TODO
   */
  static get resourceAttributes(): IResource {
    if (!_resourceAttributes) {
      _resourceAttributes = detectResourcesSync({
        detectors: [
          osDetectorSync,
          envDetectorSync,
          hostDetectorSync,
          processDetectorSync,
          serviceInstanceIdDetectorSync,
        ],
      });
    }

    return _resourceAttributes;
  }

  /**
   * The batcher is a singleton that is used to export spans to the OTel
   * endpoint. It is created lazily to avoid creating it until the Inngest App
   * has been initialized and has had a chance to receive environment variables,
   * which may be from an incoming request.
   *
   * The batcher is only referenced once we've found a span we're interested in,
   * so this should always have everything it needs on the app by then.
   */
  private get batcher(): BatchSpanProcessor {
    if (!this.#batcher) {
      // TODO Get the app from context? Or maybe we pass it in to this class.
      // Remember that this instance could be created by our middleware or by a
      // user manually creating it and passing it to their own providers.
      const url = "http://localhost:8288/v1/traces";

      processorDebug(
        "batcher lazily accessed; creating new batcher with URL",
        url
      );

      const exporter = new OTLPTraceExporter({
        url,

        // TODO This doesn't exist on the app rn, but will
        headers: {
          Authorization: `Bearer ${processEnv(envKeys.InngestSigningKey)}}`,
        },
      });

      this.#batcher = new BatchSpanProcessor(exporter);
    }

    return this.#batcher;
  }

  private trackSpan(span: Span, traceparent: string): void {
    const spanId = span.spanContext().spanId;

    this.#spanCleanup.register(span, spanId, span);
    this.#spansToExport.add(span);
    this.#traceParents.set(spanId, traceparent);
    span.setAttribute("inngest.traceparent", traceparent);
  }

  private cleanupSpan(span: Span): void {
    const spanId = span.spanContext().spanId;

    // This span is no longer in use, so we can remove it from the cleanup
    // registry.
    this.#spanCleanup.unregister(span);
    this.#spansToExport.delete(span);
    this.#traceParents.delete(spanId);
  }

  onStart(span: Span): void {
    const debug = processorDebug.extend("onStart");
    const spanId = span.spanContext().spanId;
    // 🤫 It seems to work
    const parentSpanId = (span as unknown as ReadableSpan).parentSpanId;

    // The root span isn't captured here, but we can capture children of it
    // here.

    if (!parentSpanId) {
      // All spans that Inngest cares about will have a parent, so ignore this
      debug("no parent span ID for", spanId, "so skipping it");

      return;
    }

    const traceparent = this.#traceParents.get(parentSpanId);
    if (traceparent) {
      // This span is a child of a span we care about, so add it to the list of
      // tracked spans so that we also capture its children
      debug(
        "found traceparent",
        traceparent,
        "in span ID",
        parentSpanId,
        "so adding",
        spanId
      );

      this.trackSpan(span, traceparent);
    }
  }

  onEnd(span: ReadableSpan): void {
    const debug = processorDebug.extend("onEnd");
    const spanId = span.spanContext().spanId;

    try {
      if (this.#spansToExport.has(span as unknown as Span)) {
        debug("exporting span", spanId);
        return this.batcher.onEnd(span);
      }

      debug("not exporting span", spanId, "as we don't care about it");
    } finally {
      this.cleanupSpan(span as unknown as Span);
    }
  }

  forceFlush(): Promise<void> {
    processorDebug.extend("forceFlush")("force flushing batcher");

    return this.batcher.forceFlush();
  }

  shutdown(): Promise<void> {
    processorDebug.extend("shutdown")("shutting down batcher");

    return this.batcher.shutdown();
  }
}
