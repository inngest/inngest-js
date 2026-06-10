import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { expect, test, vi } from "vitest";
import { InngestAIMetadataSpanProcessor } from "./processor.ts";

// Guards against a noisy-neighbor failure mode: the AI metadata processor is a
// process-level singleton, so it can track multiple Inngest execution roots at
// once. Metadata extracted from a span must route only to the callback for the
// root that owns that span.
test("AI metadata processor routes metadata to the owning execution callback", async () => {
  const processor = new InngestAIMetadataSpanProcessor();
  const provider = new BasicTracerProvider({
    spanProcessors: [processor],
  });
  const tracer = provider.getTracer("test");
  const firstExecutionMetadata = vi.fn(() => {
    return true;
  });
  const secondExecutionMetadata = vi.fn(() => {
    return true;
  });

  try {
    const firstRootSpan = tracer.startSpan("inngest.execution");
    const secondRootSpan = tracer.startSpan("inngest.execution");

    // Each execution root carries its own metadata callback. Descendant spans
    // should use the callback attached to their root span, not another
    // active root tracked by the singleton processor.
    processor.declareStartingSpan({
      onMetadata: firstExecutionMetadata,
      span: firstRootSpan,
      runId: "run-id-1",
      traceparent: undefined,
      tracestate: undefined,
    });
    processor.declareStartingSpan({
      onMetadata: secondExecutionMetadata,
      span: secondRootSpan,
      runId: "run-id-2",
      traceparent: undefined,
      tracestate: undefined,
    });

    const wrapperSpan = tracer.startSpan(
      "wrapper",
      {},
      trace.setSpan(context.active(), firstRootSpan),
    );
    const aiSpan = tracer.startSpan(
      "openai.chat",
      {
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.response.model": "gpt-5.4-nano",
          "gen_ai.system": "openai",
          "gen_ai.usage.input_tokens": 11,
          "gen_ai.usage.output_tokens": 17,
        },
      },
      trace.setSpan(context.active(), wrapperSpan),
    );

    // Ending the descendant AI span should call only firstRootSpan's callback.
    aiSpan.end();
    wrapperSpan.end();
    firstRootSpan.end();
    secondRootSpan.end();
  } finally {
    await provider.shutdown();
  }

  expect(firstExecutionMetadata).toHaveBeenCalledTimes(1);
  expect(firstExecutionMetadata).toHaveBeenCalledWith({
    "input-tokens": 11,
    model: "gpt-5.4-nano",
    "output-tokens": 17,
  });
  expect(secondExecutionMetadata).not.toHaveBeenCalled();
});
