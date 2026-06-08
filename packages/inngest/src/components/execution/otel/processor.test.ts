import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { deterministicSpanID } from "../../../helpers/deterministicId.ts";
import { Attribute, TraceStateKey } from "./consts.ts";
import { InngestSpanProcessor } from "./processor.ts";

// Provide an async context so `ensureBatcherInitialized` can build a (never
// flushed) batcher without throwing. We only assert on span attributes, which
// are set synchronously in `trackSpan` — independent of the batcher.
vi.mock("../als.ts", () => ({
  getAsyncCtx: async () => ({
    app: {
      apiBaseUrl: "http://localhost:8288",
      headers: {},
      signingKey: "signkey-test-0000",
    },
  }),
}));

/**
 * Characterization test: pins the attributes `InngestSpanProcessor` stamps onto
 * tracked spans. This is the behavior being relocated into the base/subclass
 * hooks, and nothing else covers it — so it guards the refactor.
 */
describe("InngestSpanProcessor attribute output", () => {
  const RUN_ID = "run-123";
  const TRACEPARENT = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
  const TRACESTATE = [
    `${TraceStateKey.AppId}=app-xyz`,
    `${TraceStateKey.FunctionId}=fn-abc`,
    `${TraceStateKey.TraceRef}=ref-789`,
  ].join(",");

  afterEach(() => {
    trace.disable();
    context.disable();
  });

  function setup() {
    const processor = new InngestSpanProcessor();
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");
    return { processor, tracer };
  }

  function attrsOf(span: unknown): Record<string, unknown> {
    return (span as { attributes: Record<string, unknown> }).attributes;
  }

  test("stamps run/trace identifiers + tracestate ids on a tracked child span", () => {
    const { processor, tracer } = setup();

    const root = tracer.startSpan("inngest.execution");
    processor.declareStartingSpan({
      span: root,
      runId: RUN_ID,
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });

    const child = tracer.startSpan(
      "child",
      undefined,
      trace.setSpan(context.active(), root),
    );

    const a = attrsOf(child);
    expect(a[Attribute.InngestRunId]).toBe(RUN_ID);
    expect(a[Attribute.InngestTraceparent]).toBe(TRACEPARENT);
    expect(a[Attribute.InngestAppId1]).toBe("app-xyz");
    expect(a[Attribute.InngestAppId2]).toBe("app-xyz");
    expect(a[Attribute.InngestFunctionId]).toBe("fn-abc");
    expect(a[Attribute.InngestTraceRef]).toBe("ref-789");
  });

  test("stamps step attributes + deterministic step parent id during step execution", () => {
    const { processor, tracer } = setup();

    const root = tracer.startSpan("inngest.execution");
    const rootSpanId = root.spanContext().spanId;
    processor.declareStartingSpan({
      span: root,
      runId: RUN_ID,
      traceparent: TRACEPARENT,
      tracestate: TRACESTATE,
    });

    const hashedStepId = "hashed-step-1";
    const attempt = 2;
    processor.declareStepExecution(
      rootSpanId,
      "my-step",
      0,
      hashedStepId,
      attempt,
    );

    const child = tracer.startSpan(
      "step-child",
      undefined,
      trace.setSpan(context.active(), root),
    );

    const a = attrsOf(child);
    expect(a[Attribute.InngestStepId]).toBe("my-step");
    expect(a[Attribute.InngestStepIndex]).toBe(0);
    expect(a[Attribute.InngestStepHash]).toBe(hashedStepId);
    expect(a[Attribute.InngestStepAttempt]).toBe(attempt);

    // Direct children of the root during step execution get the deterministic
    // step-parent span id (seed = hashedStepId:attempt).
    expect(a[Attribute.InngestStepParentSpanId]).toBe(
      deterministicSpanID(`${hashedStepId}:${attempt}`),
    );
  });

  test("does not track spans whose parent is not a tracked Inngest span", () => {
    const { tracer } = setup();

    // No declareStartingSpan → this root and its child are unrelated to any run.
    const orphan = tracer.startSpan("orphan");
    const child = tracer.startSpan(
      "orphan-child",
      undefined,
      trace.setSpan(context.active(), orphan),
    );

    expect(attrsOf(child)[Attribute.InngestRunId]).toBeUndefined();
  });
});
