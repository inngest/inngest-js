import { type Attributes, context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { Logger } from "../../../middleware/logger.ts";
import { Attribute } from "./consts.ts";
import { InngestMetadataSpanProcessor } from "./metadataProcessor.ts";

const TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

function makeLogger() {
  const logger: Logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return { logger };
}

describe("InngestMetadataSpanProcessor", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  function setup() {
    const { logger } = makeLogger();
    const processor = new InngestMetadataSpanProcessor(logger);
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");
    return { processor, tracer };
  }

  function attrsOf(span: unknown): Record<string, unknown> {
    return (span as { attributes: Record<string, unknown> }).attributes;
  }

  /** Start a child span under `root`, optionally with attributes, and end it. */
  function endChild(
    tracer: ReturnType<BasicTracerProvider["getTracer"]>,
    root: ReturnType<ReturnType<BasicTracerProvider["getTracer"]>["startSpan"]>,
    name: string,
    attributes?: Attributes,
  ) {
    const child = tracer.startSpan(
      name,
      attributes ? { attributes } : undefined,
      trace.setSpan(context.active(), root),
    );
    child.end();
  }

  function declaredRoot(
    processor: InngestMetadataSpanProcessor,
    tracer: ReturnType<BasicTracerProvider["getTracer"]>,
  ) {
    const root = tracer.startSpan("inngest.execution");
    const rootSpanId = root.spanContext().spanId;
    processor.declareStartingSpan({
      span: root,
      runId: "run-1",
      traceparent: TRACEPARENT,
      tracestate: undefined,
    });
    return { root, rootSpanId };
  }

  test("is read-only: stamps no attributes on tracked spans", () => {
    const { processor, tracer } = setup();
    const { root } = declaredRoot(processor, tracer);

    const child = tracer.startSpan(
      "child",
      undefined,
      trace.setSpan(context.active(), root),
    );

    expect(attrsOf(child)[Attribute.InngestRunId]).toBeUndefined();
    expect(attrsOf(child)[Attribute.InngestTraceparent]).toBeUndefined();
    expect(attrsOf(root)[Attribute.InngestRunId]).toBeUndefined();
  });

  test("extracts AI metadata from spans that end while a step window is open", () => {
    const { processor, tracer } = setup();
    const { root, rootSpanId } = declaredRoot(processor, tracer);

    processor.openStepWindow(rootSpanId);
    endChild(tracer, root, "llm", {
      "gen_ai.request.model": "gpt-4.1-nano",
      "gen_ai.usage.input_tokens": 42,
    });
    const result = processor.closeStepWindow(rootSpanId);

    expect(result).toEqual({
      kind: "inngest.ai",
      values: { model: "gpt-4.1-nano", input_tokens: 42 },
    });
  });

  test("sums input tokens and keeps the first-seen model across spans", () => {
    const { processor, tracer } = setup();
    const { root, rootSpanId } = declaredRoot(processor, tracer);

    processor.openStepWindow(rootSpanId);
    endChild(tracer, root, "llm-1", {
      "gen_ai.request.model": "gpt-4.1-nano",
      "gen_ai.usage.input_tokens": 10,
    });
    endChild(tracer, root, "llm-2", {
      "gen_ai.request.model": "gpt-4.1-mini",
      "gen_ai.usage.input_tokens": 5,
    });
    const result = processor.closeStepWindow(rootSpanId);

    expect(result).toEqual({
      kind: "inngest.ai",
      values: { model: "gpt-4.1-nano", input_tokens: 15 },
    });
  });

  test("returns undefined for a step window with no AI spans", () => {
    const { processor, tracer } = setup();
    const { root, rootSpanId } = declaredRoot(processor, tracer);

    processor.openStepWindow(rootSpanId);
    // A tracked span with no AI attributes contributes nothing.
    endChild(tracer, root, "plain");
    expect(processor.closeStepWindow(rootSpanId)).toBeUndefined();
  });

  test("ignores AI spans that end with no open window", () => {
    const { processor, tracer } = setup();
    const { root, rootSpanId } = declaredRoot(processor, tracer);

    // No openStepWindow yet → this span's AI metadata is not captured.
    endChild(tracer, root, "before-window", {
      "gen_ai.request.model": "gpt-4.1-nano",
      "gen_ai.usage.input_tokens": 99,
    });

    processor.openStepWindow(rootSpanId);
    expect(processor.closeStepWindow(rootSpanId)).toBeUndefined();
  });

  test("ignores spans that are not part of a declared run", () => {
    const { processor, tracer } = setup();

    // No declareStartingSpan → nothing is tracked, so even an open window on an
    // unknown root captures nothing.
    const orphan = tracer.startSpan("orphan");
    const orphanId = orphan.spanContext().spanId;
    processor.openStepWindow(orphanId);
    endChild(tracer, orphan, "orphan-child", {
      "gen_ai.request.model": "gpt-4.1-nano",
      "gen_ai.usage.input_tokens": 7,
    });
    orphan.end();

    expect(processor.closeStepWindow(orphanId)).toBeUndefined();
  });
});
