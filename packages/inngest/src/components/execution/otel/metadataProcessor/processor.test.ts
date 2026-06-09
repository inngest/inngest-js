import { context, trace } from "@opentelemetry/api";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { fromPartial } from "@total-typescript/shoehorn";
import { expect, test, vi } from "vitest";
import { ExecutionVersion } from "../../../../helpers/consts.ts";
import { createClient } from "../../../../test/helpers.ts";
import type { Context } from "../../../../types.ts";
import { getAsyncLocalStorage } from "../../als.ts";
import type { IInngestExecution } from "../../InngestExecution.ts";
import { aiMetadataKind } from "./metadata.ts";
import { InngestAIMetadataSpanProcessor } from "./processor.ts";

// Guards against a noisy-neighbor failure mode: OTel providers are shared
// process-wide, so every registered processor sees every span. A processor must
// only attach metadata for spans under an execution root declared to it.
test("AI metadata processor ignores spans owned by another client processor", async () => {
  const owningProcessor = new InngestAIMetadataSpanProcessor();
  const neighboringProcessor = new InngestAIMetadataSpanProcessor();

  // Simulate one process-global OTel provider shared by multiple Inngest
  // clients. Every processor on this provider sees every span lifecycle event.
  const provider = new BasicTracerProvider({
    spanProcessors: [owningProcessor, neighboringProcessor],
  });

  const tracer = provider.getTracer("test");
  const client = createClient({ id: "test" });
  const addMetadata = vi.fn(() => true);
  const execution = fromPartial<IInngestExecution>({
    addMetadata,
    headers: {},
    version: ExecutionVersion.V2,
  });
  const als = await getAsyncLocalStorage();

  try {
    await als.run(
      {
        app: client,
        execution: {
          ctx: fromPartial<Context.Any>({ runId: "run-id" }),
          executingStep: { id: "my-step" },
          instance: execution,
        },
      },
      async () => {
        const rootSpan = tracer.startSpan("inngest.execution");

        // The engine declares the execution root only to processors registered
        // for the client being run. The neighboring processor still sees the
        // spans, but it should not treat this root as owned.
        owningProcessor.declareStartingSpan({
          span: rootSpan,
          runId: "run-id",
          traceparent: undefined,
          tracestate: undefined,
        });

        const childSpan = tracer.startSpan(
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
          trace.setSpan(context.active(), rootSpan),
        );

        // Ending the child span fans out onEnd() to both processors. Only the
        // processor that tracked the declared root should attach metadata.
        childSpan.end();
        rootSpan.end();
      },
    );
  } finally {
    await provider.shutdown();
  }

  // If the neighboring processor treated the shared span as its own, this would
  // be called twice with duplicated AI metadata.
  expect(addMetadata).toHaveBeenCalledExactlyOnceWith(
    "my-step",
    aiMetadataKind,
    "step",
    "merge",
    {
      "input-tokens": 11,
      model: "gpt-5.4-nano",
      "output-tokens": 17,
    },
  );
});
