import { DEV_SERVER_URL, waitFor } from "@inngest/test-harness";
import { trace } from "@opentelemetry/api";
import { z } from "zod/v3";

export async function waitForOtelProvider(): Promise<void> {
  await waitFor(() => {
    const span = trace.getTracer("inngest-test").startSpan("otel-ready");
    try {
      if (!span.isRecording()) {
        throw new Error("OTel provider is not ready");
      }
    } finally {
      span.end();
    }
  });
}

export function simulateOpenAICall(): string {
  const tracer = trace.getTracer("@opentelemetry/instrumentation-openai");
  return tracer.startActiveSpan(
    "open-ai-span",
    {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": "gpt-5.4-nano",
        "gen_ai.response.model": "gpt-5.4-nano-2026-03-17",
        "gen_ai.system": "openai",
        "gen_ai.usage.input_tokens": 18,
        "gen_ai.usage.output_tokens": 39,
      },
    },
    (span) => {
      span.end();
      return "done";
    },
  );
}

const fetchTraceStepsQuery = `
  query Query($runID: String!, $preview: Boolean) {
    run(runID: $runID) {
      trace(preview: $preview) {
        childrenSpans {
          childrenSpans {
            isUserland
            name
          }
          metadata {
            scope
            kind
            values
          }
          name
        }
      }
    }
  }`;

const metadataSchema = z.object({
  kind: z.string(),
  scope: z.string(),
  values: z.record(z.unknown()),
});

const userlandSpanSchema = z.object({
  isUserland: z.boolean(),
  name: z.string(),
});

export type UserlandSpan = z.infer<typeof userlandSpanSchema>;

const traceStepSchema = z.object({
  childrenSpans: z.array(userlandSpanSchema),
  metadata: z.array(metadataSchema),
  name: z.string(),
});

export type TraceStep = z.infer<typeof traceStepSchema>;

const fetchTraceStepsResponseSchema = z.object({
  data: z.object({
    run: z
      .object({
        trace: z.object({
          childrenSpans: z.array(traceStepSchema),
        }),
      })
      .nullable(),
  }),
});

async function fetchTraceSteps(runId: string): Promise<TraceStep[] | null> {
  const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
    body: JSON.stringify({
      operationName: "Query",
      query: fetchTraceStepsQuery,
      variables: { preview: true, runID: runId },
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const parsed = fetchTraceStepsResponseSchema.parse(await res.json());
  const run = parsed.data.run;
  if (!run) {
    return null;
  }

  return run.trace.childrenSpans;
}

export async function waitForTraceSteps(runId: string): Promise<TraceStep[]> {
  return waitFor(async () => {
    const steps = await fetchTraceSteps(runId);
    if (!steps) {
      throw new Error("Run trace not found");
    }

    return steps;
  });
}
