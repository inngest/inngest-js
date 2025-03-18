/* eslint-disable @typescript-eslint/no-var-requires */
import Debug from "debug";
const baseDebug = Debug("inngest:otel");

/**
 * Attempt to import a variety of automatic instrumentations, swallowing errors.
 *
 * This allows us to automatically capture spans for a variety of common cases.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const importAttempts: (Instrumentation | Instrumentation[])[] = [
  (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const {
        getNodeAutoInstrumentations,
      } = require("@opentelemetry/auto-ianstrumentations-node");

      // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call
      return getNodeAutoInstrumentations();
    } catch (err) {
      baseDebug(
        "failed to import @opentelemetry/auto-instrumentations-node",
        err?.toString?.().split?.("\n")?.[0] ?? err
      );
    }
  })(),
].filter(Boolean);

import { trace, type Span } from "@opentelemetry/api";
import { AsyncHooksContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  registerInstrumentations,
  type Instrumentation,
} from "@opentelemetry/instrumentation";
import {
  detectResourcesSync,
  envDetectorSync,
  hostDetectorSync,
  osDetectorSync,
  processDetectorSync,
  serviceInstanceIdDetectorSync,
  type IResource,
} from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { envKeys } from "../../helpers/consts.js";
import { processEnv } from "../../helpers/env.js";
import { version } from "../../version.js";
import { type Inngest } from "../Inngest.js";
import { InngestMiddleware } from "../InngestMiddleware.js";

export type Behaviour = "createProvider" | "extendProvider" | "off" | "auto";
export type Instrumentations = (Instrumentation | Instrumentation[])[];

let _resourceAttributes: IResource | undefined;

const processorDebug = baseDebug.extend("InngestSpanProcessor");

/**
 * TODO
 */
const clientProcessorMap = new WeakMap<Inngest.Any, InngestSpanProcessor>();

/**
 * TODO
 */
export const getClientProcessor = (client: Inngest.Any) => {
  return clientProcessorMap.get(client);
};

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

// TODO Ugh need an onClose hook to shutdown lol
export const otelMiddleware = ({
  behaviour = "auto",
  instrumentations,
}: {
  behaviour?: Behaviour;
  instrumentations?: Instrumentations;
} = {}) => {
  const debug = baseDebug.extend("middleware");
  debug("behaviour:", behaviour);

  let processor: InngestSpanProcessor | undefined;

  switch (behaviour) {
    case "auto": {
      const extended = extendProvider(behaviour);
      if (extended.success) {
        debug("extended existing provider");
        processor = extended.processor;
        break;
      }

      const created = createProvider(behaviour, instrumentations);
      if (created.success) {
        debug("created new provider");
        processor = created.processor;
        break;
      }

      console.warn("no provider found to extend and unable to create one");

      break;
    }
    case "createProvider": {
      const created = createProvider(behaviour, instrumentations);
      if (created.success) {
        debug("created new provider");
        processor = created.processor;
        break;
      }

      console.warn("unable to create provider, OTel middleware will not work");

      break;
    }
    case "extendProvider": {
      const extended = extendProvider(behaviour);
      if (extended.success) {
        debug("extended existing provider");
        processor = extended.processor;
        break;
      }

      console.warn(
        'unable to extend provider, OTel middleware will not work. Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.'
      );

      break;
    }
    case "off": {
      break;
    }
    default: {
      // unknown
      console.warn(
        `unknown behaviour ${JSON.stringify(behaviour)}, defaulting to "off"`
      );
    }
  }

  return new InngestMiddleware({
    name: "Inngest: OTel",
    init({ client }) {
      // TODO Set client->processor weakmap here, from a processor that has been
      // created either in create or extend provider.
      if (processor) {
        clientProcessorMap.set(client, processor);
      }

      return {
        onFunctionRun() {
          return {
            transformInput() {
              return {
                ctx: {
                  /**
                   * TODO
                   */
                  tracer: trace.getTracer("inngest", version),
                },
              };
            },
          };
        },
      };
    },
  });
};

const createProvider = (
  behaviour: Behaviour,
  instrumentations: Instrumentations | undefined = []
): { success: true; processor: InngestSpanProcessor } | { success: false } => {
  // TODO How do we tell if there's an existing provider?
  const processor = new InngestSpanProcessor();

  const p = new BasicTracerProvider({
    spanProcessors: [processor],
  });

  const instrList: Instrumentations = [
    ...instrumentations,
    ...(importAttempts.filter(Boolean) as Instrumentations),
  ];

  registerInstrumentations({
    instrumentations: instrList,
  });

  p.register({
    contextManager: new AsyncHooksContextManager().enable(),
  });

  return { success: true, processor };
};

/**
 * Attempts to extend the existing OTel provider with our processor. Returns true
 * if the provider was extended, false if it was not.
 */
const extendProvider = (
  behaviour: Behaviour
): { success: true; processor: InngestSpanProcessor } | { success: false } => {
  // Attempt to add our processor and export to the existing provider
  const existingProvider = trace.getTracerProvider();
  if (!existingProvider) {
    if (behaviour !== "auto") {
      console.warn(
        'No existing OTel provider found and behaviour is "extendProvider". Inngest\'s OTel middleware will not work. Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.'
      );
    }

    return { success: false };
  }

  if (
    !("addSpanProcessor" in existingProvider) ||
    typeof existingProvider.addSpanProcessor !== "function"
  ) {
    // TODO Could we also add a function the user can provide that takes the
    // processor and adds it? That way they could support many different
    // providers.
    if (behaviour !== "auto") {
      console.warn(
        "Existing OTel provider is not a BasicTracerProvider. Inngest's OTel middleware will not work, as it can only extend an existing processor if it's a BasicTracerProvider."
      );
    }

    return { success: false };
  }

  const processor = new InngestSpanProcessor();
  existingProvider.addSpanProcessor(processor);

  return { success: true, processor };
};
