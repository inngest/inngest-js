import { createServer } from "node:http";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
} from "@opentelemetry/sdk-trace-base";
import { runFnWithStack } from "../../../test/helpers.ts";
import { Inngest } from "../../Inngest.ts";
import { getAsyncLocalStorage, runWithAsyncCtx } from "../als.ts";
import { InngestSpanProcessor } from "./processor.ts";

describe("InngestSpanProcessor", () => {
  test("warns once and flushes quickly when the API rejects the export", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(429, { "Retry-After": "60" });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("expected a TCP address");
    }
    const { port } = addr;

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const app = new Inngest({
      id: "test",
      logger,
      baseUrl: `http://localhost:${port}`,
      eventKey: "ek",
      signingKey: "signkey-test-abc",
    });

    const processor = new InngestSpanProcessor(app);
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    const tracer = provider.getTracer("test");

    await getAsyncLocalStorage();
    runWithAsyncCtx({ app }, () => {
      const span = tracer.startSpan("root");
      processor.declareStartingSpan({
        span,
        runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
        tracestate: undefined,
      });
      span.end();
    });

    try {
      const start = Date.now();
      await processor.forceFlush();
      await processor.forceFlush();

      expect(Date.now() - start).toBeLessThan(2000);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0]?.[1]).toMatch(/extended traces/);
    } finally {
      await provider.shutdown();
      server.close();
    }
  });

  test.each([
    {
      ending: "its root span ends",
      sampler: new AlwaysOnSampler(),
      hasTraceparent: true,
      engineClears: false,
    },
    {
      //
      // A dropped root span is non-recording, so it never reaches `onEnd`,
      // and without a traceparent it isn't registered for cleanup on GC.
      ending: "the engine clears a root span the sampler dropped",
      sampler: new AlwaysOffSampler(),
      hasTraceparent: false,
      engineClears: true,
    },
  ])("holds nothing for an execution once $ending", async (scenario) => {
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address();
    if (!addr || typeof addr === "string") {
      throw new Error("expected a TCP address");
    }

    const app = new Inngest({
      id: "test",
      baseUrl: `http://localhost:${addr.port}`,
      eventKey: "ek",
      signingKey: "signkey-test-abc",
    });
    const processor = new InngestSpanProcessor(app);
    const provider = new BasicTracerProvider({
      sampler: scenario.sampler,
      spanProcessors: [processor],
    });
    const tracer = provider.getTracer("test");

    // The processor's sets are private, so record every Set the root span ID
    // is added to while the execution runs.
    const setsHoldingId = new Set<Set<unknown>>();
    let rootSpanId = "";
    const add = Set.prototype.add;
    const addSpy = vi.spyOn(Set.prototype, "add").mockImplementation(function (
      this: Set<unknown>,
      value: unknown,
    ) {
      if (rootSpanId && value === rootSpanId) setsHoldingId.add(this);
      return add.call(this, value);
    });

    try {
      await getAsyncLocalStorage();
      runWithAsyncCtx({ app }, () => {
        const span = tracer.startSpan("inngest.execution");
        rootSpanId = span.spanContext().spanId;
        processor.declareStartingSpan({
          span,
          runId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
          traceparent: scenario.hasTraceparent
            ? `00-${span.spanContext().traceId}-${rootSpanId}-01`
            : undefined,
          tracestate: undefined,
        });
        processor.declareStepExecution(rootSpanId, "step", 0, "hashed", 1);
        processor.clearStepExecution(rootSpanId);
        span.end();
        if (scenario.engineClears) processor.clearStartingSpan(span);
      });
    } finally {
      addSpy.mockRestore();
    }

    try {
      expect(setsHoldingId.size).toBeGreaterThan(0);
      for (const set of setsHoldingId) {
        expect(set.has(rootSpanId)).toBe(false);
      }
    } finally {
      await provider.shutdown();
      server.close();
    }
  });

  test("is told by the engine when an execution finishes", async () => {
    const app = new Inngest({ id: "test", isDev: true });
    const processor = new InngestSpanProcessor(app);
    const declared = vi.spyOn(processor, "declareStartingSpan");
    const cleared = vi.spyOn(processor, "clearStartingSpan");

    const fn = app.createFunction(
      { id: "fn", triggers: [{ event: "foo" }] },
      () => "done",
    );

    try {
      await runFnWithStack(fn, {});

      expect(cleared).toHaveBeenCalledExactlyOnceWith(
        declared.mock.calls[0]?.[0].span,
      );
    } finally {
      await processor.shutdown();
    }
  });
});
