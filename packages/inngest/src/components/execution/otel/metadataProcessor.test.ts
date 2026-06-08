import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import type { Logger } from "../../../middleware/logger.ts";
import { Attribute } from "./consts.ts";
import { InngestMetadataSpanProcessor } from "./metadataProcessor.ts";

const TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";

function makeLogger() {
  const infos: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const logger: Logger = {
    info: (obj: unknown, msg?: unknown) =>
      infos.push({ obj: obj as Record<string, unknown>, msg: String(msg) }),
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  return { logger, infos };
}

describe("InngestMetadataSpanProcessor", () => {
  afterEach(() => {
    trace.disable();
    context.disable();
  });

  function setup() {
    const { logger, infos } = makeLogger();
    const processor = new InngestMetadataSpanProcessor(logger);
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");
    return { processor, tracer, infos };
  }

  function attrsOf(span: unknown): Record<string, unknown> {
    return (span as { attributes: Record<string, unknown> }).attributes;
  }

  test("logs the run root span id for a tracked descendant on end", () => {
    const { processor, tracer, infos } = setup();

    const root = tracer.startSpan("inngest.execution");
    const rootSpanId = root.spanContext().spanId;
    processor.declareStartingSpan({
      span: root,
      runId: "run-1",
      traceparent: TRACEPARENT,
      tracestate: undefined,
    });

    const child = tracer.startSpan(
      "child",
      undefined,
      trace.setSpan(context.active(), root),
    );
    const childSpanId = child.spanContext().spanId;
    child.end();
    root.end();

    const childLog = infos.find((l) => l.obj.spanId === childSpanId);
    expect(childLog).toBeDefined();
    expect(childLog?.obj.rootSpanId).toBe(rootSpanId);

    // The root logs itself as its own root.
    const rootLog = infos.find((l) => l.obj.spanId === rootSpanId);
    expect(rootLog?.obj.rootSpanId).toBe(rootSpanId);
  });

  test("is read-only: stamps no attributes on tracked spans", () => {
    const { processor, tracer } = setup();

    const root = tracer.startSpan("inngest.execution");
    processor.declareStartingSpan({
      span: root,
      runId: "run-1",
      traceparent: TRACEPARENT,
      tracestate: undefined,
    });

    const child = tracer.startSpan(
      "child",
      undefined,
      trace.setSpan(context.active(), root),
    );

    expect(attrsOf(child)[Attribute.InngestRunId]).toBeUndefined();
    expect(attrsOf(child)[Attribute.InngestTraceparent]).toBeUndefined();
    expect(attrsOf(root)[Attribute.InngestRunId]).toBeUndefined();
  });

  test("does not log spans that are not part of a declared run", () => {
    const { tracer, infos } = setup();

    // No declareStartingSpan → nothing is tracked.
    const orphan = tracer.startSpan("orphan");
    const child = tracer.startSpan(
      "orphan-child",
      undefined,
      trace.setSpan(context.active(), orphan),
    );
    child.end();
    orphan.end();

    expect(infos).toHaveLength(0);
  });
});
