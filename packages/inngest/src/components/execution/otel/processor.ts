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
import {
  defaultDevServerHost,
  defaultInngestApiBaseUrl,
} from "../../../helpers/consts.js";
import { devServerAvailable } from "../../../helpers/devserver.js";
import { devServerHost } from "../../../helpers/env.js";
import { type Inngest } from "../../Inngest.js";
import { getAsyncCtx } from "../als.js";
import { clientProcessorMap } from "./access.js";

const processorDebug = Debug("inngest:otel:InngestSpanProcessor");
let _resourceAttributes: IResource | undefined;

/**
 * TODO
 */
export class InngestSpanProcessor implements SpanProcessor {
  /**
   * TODO
   */
  constructor(
    /**
     * TODO
     */
    app?: Inngest.Like
  ) {
    if (app) {
      clientProcessorMap.set(app as Inngest.Any, this);
    }
  }

  /**
   * TODO
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
    // Upsert the batcher ready for later. We do this here to bootstrap it with
    // the correct async context as soon as we can. As this method is only
    // called just before execution, we know we're all set up.
    //
    // Waiting to call this until we actually need the batcher would mean that
    // we might not have the correct async context set up, as we'd likely be in
    // some span lifecycle method that doesn't have the same chain of execution.
    void this.ensureBatcherInitialized();

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
  private ensureBatcherInitialized(): Promise<BatchSpanProcessor> {
    if (!this.#batcher) {
      // eslint-disable-next-line @typescript-eslint/no-misused-promises, no-async-promise-executor
      this.#batcher = new Promise(async (resolve, reject) => {
        try {
          const store = await getAsyncCtx();
          if (!store) {
            throw new Error(
              "No async context found; cannot create batcher to export traces"
            );
          }

          const app = store.app as Inngest.Any;

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
                app["fetch"]
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
            url
          );

          const exporter = new OTLPTraceExporter({
            url: url.href,

            headers: {
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
        if (!this.#batcher) {
          return debug(
            "batcher not initialized, so failed exporting span",
            spanId
          );
        }

        debug("exporting span", spanId);
        return void this.#batcher?.then((batcher) => batcher.onEnd(span));
      }

      debug("not exporting span", spanId, "as we don't care about it");
    } finally {
      this.cleanupSpan(span as unknown as Span);
    }
  }

  async forceFlush(): Promise<void> {
    processorDebug.extend("forceFlush")("force flushing batcher");

    return this.#batcher?.then((batcher) => batcher.forceFlush());
  }

  async shutdown(): Promise<void> {
    processorDebug.extend("shutdown")("shutting down batcher");

    return this.#batcher?.then((batcher) => batcher.shutdown());
  }
}

/**
 * TODO
 */
export class PublicInngestSpanProcessor extends InngestSpanProcessor {
  constructor(
    /**
     * TODO
     */
    app: Inngest.Like
  ) {
    super(app);
  }
}
