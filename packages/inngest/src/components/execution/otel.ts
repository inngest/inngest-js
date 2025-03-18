import { trace, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  type Instrumentation,
  type InstrumentationConfig,
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
import Debug from "debug";
import { envKeys } from "../../helpers/consts.js";
import { processEnv } from "../../helpers/env.js";
import { version } from "../../version.js";
import { type Inngest } from "../Inngest.js";
import { InngestMiddleware } from "../InngestMiddleware.js";

export type Behaviour = "createProvider" | "extendProvider" | "off" | "auto";
export type Instrumentations = (
  | Instrumentation<InstrumentationConfig>
  | Instrumentation<InstrumentationConfig>[]
)[];

let _resourceAttributes: IResource | undefined;

const processorDebug = Debug("inngest:otel:InngestSpanProcessor");

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

export class InngestSpanProcessor implements SpanProcessor {
  constructor(client: Inngest.Any) {
    clientProcessorMap.set(client, this);
  }

  #batcher: BatchSpanProcessor | undefined;
  #resourceAttributes: IResource | undefined;

  /**
   * A map of span IDs to the Inngest traceparent headers they belong to. This is
   * used to track spans that we care about, so that we can export them to the
   * OTel endpoint.
   */
  public allowed = new Map<string, string>();

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
    span.setAttribute("inngest.traceparent", traceparent);

    this.allowed.set(span.spanContext().spanId, traceparent);
  }

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

    const traceparent = this.allowed.get(parentSpanId);
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

      this.allowed.set(spanId, traceparent);
      span.setAttribute("inngest.traceparent", traceparent);
    }
  }

  onEnd(span: ReadableSpan): void {
    const debug = processorDebug.extend("onEnd");
    const spanId = span.spanContext().spanId;

    if (this.allowed.has(spanId)) {
      // This is a span that we care about, so make sure it gets exported by the
      // batcher
      debug("exporting span", spanId);

      this.allowed.delete(spanId);

      return this.batcher.onEnd(span);
    }

    debug(
      "not exporting span",
      span.spanContext().spanId,
      "as we don't care about it"
    );
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
  const debug = Debug("inngest:otel:middleware");
  debug("behaviour:", behaviour);

  return new InngestMiddleware({
    name: "Inngest: OTel",
    async init({ client }) {
      switch (behaviour) {
        case "auto": {
          const extended = extendProvider(client, behaviour);
          if (extended) {
            debug("extended existing provider");
            break;
          }

          const created = await createProvider(
            client,
            behaviour,
            instrumentations
          );
          if (created) {
            debug("created new provider");
            break;
          }

          console.warn("no provider found to extend and unable to create one");

          break;
        }
        case "createProvider": {
          const created = await createProvider(
            client,
            behaviour,
            instrumentations
          );
          if (created) {
            debug("created new provider");
            break;
          }

          console.warn(
            "unable to create provider, OTel middleware will not work"
          );

          break;
        }
        case "extendProvider": {
          const extended = extendProvider(client, behaviour);
          if (extended) {
            debug("extended existing provider");
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
            `unknown behaviour ${JSON.stringify(
              behaviour
            )}, defaulting to "off"`
          );
        }
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

const createProvider = async (
  app: Inngest.Any,
  behaviour: Behaviour,
  instrumentations: Instrumentations | undefined = []
): Promise<boolean> => {
  // TODO How do we tell if there's an existing provider?
  const debug = Debug("inngest:otel:middleware:createProvider");

  const p = new BasicTracerProvider({
    spanProcessors: [new InngestSpanProcessor(app)],
  });

  let contextManager;

  try {
    const { AsyncHooksContextManager } = await import(
      "@opentelemetry/context-async-hooks"
    );
    // This is critical, otherwise we won't be able to track async spans
    // correctly
    contextManager = new AsyncHooksContextManager().enable();
  } catch (_) {
    // Not in Node, or package not installed — skip context manager
    debug("error importing AsyncHooksContextManager, skipping");
  }

  try {
    const { registerInstrumentations } = await import(
      "@opentelemetry/instrumentation"
    );
    const { getNodeAutoInstrumentations } = await import(
      "@opentelemetry/auto-instrumentations-node"
    );

    registerInstrumentations({
      instrumentations: [getNodeAutoInstrumentations(), ...instrumentations],
    });
  } catch (_) {
    // instrumentation is optional
    debug("error importing automatic instrumentation, skipping");
  }

  p.register({
    contextManager,
  });

  return true;
};

/**
 * Attempts to extend the existing OTel provider with our processor. Returns true
 * if the provider was extended, false if it was not.
 */
const extendProvider = (app: Inngest.Any, behaviour: Behaviour): boolean => {
  // Attempt to add our processor and export to the existing provider
  const existingProvider = trace.getTracerProvider();
  if (!existingProvider) {
    if (behaviour !== "auto") {
      console.warn(
        'No existing OTel provider found and behaviour is "extendProvider". Inngest\'s OTel middleware will not work. Either allow the middleware to create a provider by setting `behaviour: "createProvider"` or `behaviour: "auto"`, or make sure that the provider is created and imported before the middleware is used.'
      );
    }

    return false;
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

    return false;
  }

  existingProvider.addSpanProcessor(new InngestSpanProcessor(app));

  return true;
};
