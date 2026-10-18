import { createServer } from "node:http";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
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
});
