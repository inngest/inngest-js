import type { Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  detectResources,
  envDetector,
  hostDetector,
  osDetector,
  processDetector,
  type Resource,
  serviceInstanceIdDetector,
} from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import Debug from "debug";
import {
  defaultDevServerHost,
  defaultInngestApiBaseUrl,
} from "../../../helpers/consts.ts";
import { devServerAvailable } from "../../../helpers/devserver.ts";
import { devServerHost } from "../../../helpers/env.ts";
import type { Inngest } from "../../Inngest.ts";
import { getAsyncCtx } from "../als.ts";
import { clientProcessorMap } from "./access.ts";
import { Attribute, debugPrefix, TraceStateKey } from "./consts.ts";

const processorDebug = Debug(`${debugPrefix}:InngestSpanProcessor`);

/**
 * A set of resource attributes that are used to identify the Inngest app and
 *  the function that is being executed. This is used to store the resource
 * attributes for the spans that are exported to the Inngest endpoint, and cache
 *  them for later use.
 */
let _resourceAttributes: Resource | undefined;

/**
 * A set of information about an execution that's used to set attributes on
 * userland spans sent to Inngest for proper indexing.
 */
export type ParentState = {
  traceparent: string;
  runId: string;
  appId: string | undefined;
  functionId: string | undefined;
  traceRef: string | undefined;
};

/**
 * An OTel span processor that is used to export spans to the Inngest endpoint.
 * This is used to track spans that are created within an Inngest run and export
 * them to the Inngest endpoint for tracing.
 *
 * It's careful to only pick relevant spans to export and will not send any
 * irrelevant spans to the Inngest endpoint.
 *
 * THIS IS THE INTERNAL IMPLEMENTATION OF THE SPAN PROCESSOR AND SHOULD NOT BE
 * USED BY USERS DIRECTLY. USE THE {@link PublicInngestSpanProcessor} CLASS
 * INSTEAD.
 */
export class InngestSpanProcessor implements SpanProcessor {
  /**
   * An OTel span processor that is used to export spans to the Inngest endpoint.
   * This is used to track spans that are created within an Inngest run and export
   * them to the Inngest endpoint for tracing.
   *
   * It's careful to only pick relevant spans to export and will not send any
   * irrelevant spans to the Inngest endpoint.
   */
  constructor(
    /**
     * The app that this span processor is associated with. This is used to
     * determine the Inngest endpoint to export spans to.
     *
     * It is optional here as this is the private constructor and only used
     * internally; we set `app` elsewhere as when we create the processor (as
     * early as possible when the process starts) we don't necessarily have the
     * app available yet.
     *
     * So, internally we can delay setting ths until later.
     */
    app?: Inngest.Like,
  ) {
    if (app) {
      clientProcessorMap.set(app as Inngest.Any, this);
    }
  }

  /**
   * A `BatchSpanProcessor` that is used to export spans to the Inngest
   * endpoint. This is created lazily to avoid creating it until the Inngest App
   * has been initialized and has had a chance to receive environment variables,
   * which may be from an incoming request.
   */
  #batcher: Promise<BatchSpanProcessor> | undefined;

  /**
   * A set of spans used to track spans that we care about, so that we can
   * export them to the OTel endpoint.
   *
   * If a span falls out of reference, it will be removed from this set as we'll
   * never get a chance to export it or remove it anyway.
   */
  #spansToExport = new WeakSet<Span>();

  /**
   * A map of span IDs to their parent state, which includes a block of
   * information that can be used and pushed back to the Inngest endpoint to
   * ingest spans.
   */
  #traceParents = new Map<string, ParentState>();

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
   * In order to only capture a subset of spans, we need to declare the initial
   * span that we care about and then export its children.
   *
   * Call this method (ideally just before execution starts) with that initial
   * span to trigger capturing all following children as well as initialize the
   * batcher.
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
    // Upsert the batcher ready for later. We do this here to bootstrap it with
    // the correct async context as soon as we can. As this method is only
    // called just before execution, we know we're all set up.
    //
    // Waiting to call this until we actually need the batcher would mean that
    // we might not have the correct async context set up, as we'd likely be in
    // some span lifecycle method that doesn't have the same chain of execution.
    void this.ensureBatcherInitialized();

    // If we don't have a traceparent, then we can't track this span. This is
    // likely a span that we don't care about, so we can ignore it.
    if (!traceparent) {
      return processorDebug(
        "no traceparent found for span",
        span.spanContext().spanId,
        "so skipping it",
      );
    }

    // We also attempt to use `tracestate`. The values we fetch from these
    // should be optional, as it's likely the Executor won't need us to parrot
    // them back in later versions.
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
        processorDebug(
          "failed to parse tracestate",
          tracestate,
          "so skipping it;",
          err,
        );
      }
    }

    // This is a span that we care about, so let's make sure it and its
    // children are exported.
    processorDebug.extend("declareStartingSpan")(
      "declaring:",
      span.spanContext().spanId,
      "for traceparent",
      traceparent,
    );

    // Set a load of attributes on this span so that we can nicely identify
    // runtime, paths, etc. Only this span will have these attributes.
    span.setAttributes(InngestSpanProcessor.resourceAttributes.attributes);

    this.trackSpan(
      {
        appId,
        functionId,
        runId,
        traceparent,
        traceRef,
      },
      span,
    );
  }

  /**
   * A getter for retrieving resource attributes for the current process. This
   * is used to set the resource attributes for the spans that are exported to
   * the Inngest endpoint, and cache them for later use.
   */
  static get resourceAttributes(): Resource {
    if (!_resourceAttributes) {
      _resourceAttributes = detectResources({
        detectors: [
          osDetector,
          envDetector,
          hostDetector,
          processDetector,
          serviceInstanceIdDetector,
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
  private ensureBatcherInitialized(): Promise<BatchSpanProcessor> {
    if (!this.#batcher) {
      this.#batcher = new Promise(async (resolve, reject) => {
        try {
          // We retrieve the app from the async context, so we must make sure
          // that this function is called from the correct chain.
          const store = await getAsyncCtx();
          if (!store) {
            throw new Error(
              "No async context found; cannot create batcher to export traces",
            );
          }

          const app = store.app as Inngest.Any;

          // Fetch the URL for the Inngest endpoint using the app's config.
          let url: URL;
          const path = "/v1/traces/userland";
          if (app.apiBaseUrl) {
            url = new URL(path, app.apiBaseUrl);
          } else {
            url = new URL(path, defaultInngestApiBaseUrl);

            if (app["mode"] && app["mode"].isDev && app["mode"].isInferred) {
              const devHost = devServerHost() || defaultDevServerHost;
              const hasDevServer = await devServerAvailable(
                devHost,
                app["fetch"],
              );
              if (hasDevServer) {
                url = new URL(path, devHost);
              }
            } else if (app["mode"]?.explicitDevUrl) {
              url = new URL(path, app["mode"].explicitDevUrl.href);
            }
          }

          processorDebug(
            "batcher lazily accessed; creating new batcher with URL",
            url,
          );

          const exporter = new OTLPTraceExporter({
            url: url.href,

            headers: {
              ...app["headers"],
              Authorization: `Bearer ${app["inngestApi"]["signingKey"]}`,
            },
          });

          resolve(new BatchSpanProcessor(exporter));
        } catch (err) {
          reject(err);
        }
      });
    }

    return this.#batcher;
  }

  /**
   * Mark a span as being tracked by this processor, meaning it will be exported
   * to the Inggest endpoint when it ends.
   */
  private trackSpan(parentState: ParentState, span: Span): void {
    const spanId = span.spanContext().spanId;

    this.#spanCleanup.register(span, spanId, span);
    this.#spansToExport.add(span);
    this.#traceParents.set(spanId, parentState);

    span.setAttribute(Attribute.InngestTraceparent, parentState.traceparent);
    span.setAttribute(Attribute.InngestRunId, parentState.runId);

    // Setting app ID is optional; it's likely in future versions of the
    // Executor that we don't need to parrot this back.
    if (parentState.appId) {
      span.setAttribute(Attribute.InngestAppId1, parentState.appId);
      span.setAttribute(Attribute.InngestAppId2, parentState.appId);
    }

    // Setting function ID is optional; it's likely in future versions of the
    // Executor that we don't need to parrot this back.
    if (parentState.functionId) {
      span.setAttribute(Attribute.InngestFunctionId, parentState.functionId);
    }

    if (parentState.traceRef) {
      span.setAttribute(Attribute.InngestTraceRef, parentState.traceRef);
    }
  }

  /**
   * Clean up any references to a span that has ended. This is used to avoid
   * memory leaks in the case where a span is not exported, remains unended, and
   * is left in memory before being GC'd.
   */
  private cleanupSpan(span: Span): void {
    const spanId = span.spanContext().spanId;

    // This span is no longer in use, so we can remove it from the cleanup
    // registry.
    this.#spanCleanup.unregister(span);
    this.#spansToExport.delete(span);
    this.#traceParents.delete(spanId);
  }

  /**
   * An implementation of the `onStart` method from the `SpanProcessor`
   * interface. This is called when a span is started, and is used to track
   * spans that are children of spans we care about.
   */
  onStart(span: Span): void {
    const debug = processorDebug.extend("onStart");
    const spanId = span.spanContext().spanId;
    // 🤫 It seems to work
    const parentSpanId = (span as unknown as ReadableSpan).parentSpanContext
      ?.spanId;

    // The root span isn't captured here, but we can capture children of it
    // here.

    if (!parentSpanId) {
      // All spans that Inngest cares about will have a parent, so ignore this
      debug("no parent span ID for", spanId, "so skipping it");

      return;
    }

    const parentState = this.#traceParents.get(parentSpanId);
    if (parentState) {
      // This span is a child of a span we care about, so add it to the list of
      // tracked spans so that we also capture its children
      debug(
        "found traceparent",
        parentState,
        "in span ID",
        parentSpanId,
        "so adding",
        spanId,
      );

      this.trackSpan(parentState, span);
    }
  }

  /**
   * An implementation of the `onEnd` method from the `SpanProcessor` interface.
   * This is called when a span ends, and is used to export spans to the Inngest
   * endpoint.
   */
  onEnd(span: ReadableSpan): void {
    const debug = processorDebug.extend("onEnd");
    const spanId = span.spanContext().spanId;

    try {
      if (this.#spansToExport.has(span as unknown as Span)) {
        if (!this.#batcher) {
          return debug(
            "batcher not initialized, so failed exporting span",
            spanId,
          );
        }

        debug("exporting span", spanId);
        return void this.#batcher.then((batcher) => batcher.onEnd(span));
      }

      debug("not exporting span", spanId, "as we don't care about it");
    } finally {
      this.cleanupSpan(span as unknown as Span);
    }
  }

  /**
   * An implementation of the `forceFlush` method from the `SpanProcessor`
   * interface. This is called to force the processor to flush any spans that
   * are currently in the batcher. This is used to ensure that spans are
   * exported to the Inngest endpoint before the process exits.
   *
   * Notably, we call this in the `beforeResponse` middleware hook to ensure
   * that spans for a run as exported as soon as possible and before the
   * serverless process is killed.
   */
  async forceFlush(): Promise<void> {
    const flushDebug = processorDebug.extend("forceFlush");
    flushDebug("force flushing batcher");

    return this.#batcher
      ?.then((batcher) => batcher.forceFlush())
      .catch((err) => {
        flushDebug("error flushing batcher", err, "ignoring");
      });
  }

  async shutdown(): Promise<void> {
    processorDebug.extend("shutdown")("shutting down batcher");

    return this.#batcher?.then((batcher) => batcher.shutdown());
  }
}

/**
 * An OTel span processor that is used to export spans to the Inngest endpoint.
 * This is used to track spans that are created within an Inngest run and export
 * them to the Inngest endpoint for tracing.
 *
 * It's careful to only pick relevant spans to export and will not send any
 * irrelevant spans to the Inngest endpoint.
 */
export class PublicInngestSpanProcessor extends InngestSpanProcessor {
  constructor(
    /**
     * The app that this span processor is associated with. This is used to
     * determine the Inngest endpoint to export spans to.
     */
    app: Inngest.Like,
  ) {
    super(app);
  }
}
