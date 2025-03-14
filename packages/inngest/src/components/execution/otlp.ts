import { trace, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  type Instrumentation,
  type InstrumentationConfig,
} from "@opentelemetry/instrumentation";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { envKeys } from "../../helpers/consts.js";
import { processEnv } from "../../helpers/env.js";
import { InngestMiddleware } from "../InngestMiddleware.js";

const allowed = new Set<string>();

export class InngestSpanProcessor implements SpanProcessor {
  private batcher: BatchSpanProcessor;

  constructor(readonly exporter: SpanExporter) {
    this.batcher = new BatchSpanProcessor(exporter);
  }

  static declareStartingSpan(span: Span): void {
    console.log("declareStartingSpan: Starting span", span);

    // This is a span that we care about, so let's make sure it and its
    // children are exported.
    allowed.add(span.spanContext().spanId);
  }

  onStart(span: ReadableSpan): void {
    // The root span isn't captured here, but we can capture children of it
    // here.

    if (!span.parentSpanId) {
      console.log("onStart: no parent span id", span);
      // All spans that Inngest cares about will have a parent, so ignore this
      return;
    }

    if (allowed.has(span.parentSpanId)) {
      console.log("onStart: parent span id found", span);
      // This span is a child of a span we care about, so add it to the list of
      // tracked spans so that we also capture its children
      allowed.add(span.spanContext().spanId);
    }
  }

  onEnd(span: ReadableSpan): void {
    if (allowed.has(span.spanContext().spanId)) {
      // This is a span that we care about, so make sure it gets exported by the
      // batcher
      allowed.delete(span.spanContext().spanId);
      console.log("onEnd: Exporting span", span);
      return this.batcher.onEnd(span);
    }

    console.log("onEnd: Not exporting span", span);
  }

  forceFlush(): Promise<void> {
    console.log("forceFlush: Flushing spans");
    return this.batcher.forceFlush();
  }

  shutdown(): Promise<void> {
    console.log("shutdown: Shutting down batcher");
    return this.batcher.shutdown();
  }
}

// TODO Ugh need an onClose hook
export const otlpMiddleware = (opts: {
  createProvider?: boolean;
  instrumentations?: (
    | Instrumentation<InstrumentationConfig>
    | Instrumentation<InstrumentationConfig>[]
  )[];
}) => {
  return new InngestMiddleware({
    name: "Inngest: OTLP",
    init() {
      const provider = (async () => {
        if (!opts.createProvider) {
          return undefined;
        }

        const exporter = new OTLPTraceExporter({
          // TODO This will change based on the client
          url: "http://localhost:8288/v1/traces",

          // TODO This doesn't exist on the client rn, but will
          headers: {
            Authorization: `Bearer ${processEnv(envKeys.InngestSigningKey)}}`,
          },
        });

        const p = new BasicTracerProvider({
          spanProcessors: [new InngestSpanProcessor(exporter)],
        });

        let contextManager;

        try {
          const { AsyncHooksContextManager } = await import(
            "@opentelemetry/context-async-hooks"
          );
          contextManager = new AsyncHooksContextManager().enable();
        } catch (_) {
          // Not in Node, or package not installed — skip context manager
          console.warn("UJHUHHHUH");
        }

        try {
          const { registerInstrumentations } = await import(
            "@opentelemetry/instrumentation"
          );
          const { getNodeAutoInstrumentations } = await import(
            "@opentelemetry/auto-instrumentations-node"
          );

          registerInstrumentations({
            instrumentations: [
              getNodeAutoInstrumentations(),
              ...(opts.instrumentations ?? []),
            ],
          });
        } catch (_) {
          // instrumentation is optional
          console.warn("IFLUHSDUHIFDHSISDISHDFHSIDHF");
        }

        p.register({
          contextManager,
        });

        return p;
      })();

      return {
        onFunctionRun() {
          const tracer = trace.getTracer("inngest");

          return {
            transformInput() {
              return {
                ctx: {
                  /**
                   * TODO
                   */
                  tracer,
                },
              };
            },

            async beforeResponse() {
              await (await provider)?.forceFlush();
            },
          };
        },
      };
    },
  });
};
