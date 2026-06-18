import { DEV_SERVER_URL, waitFor } from "@inngest/test-harness";
import { trace } from "@opentelemetry/api";
import { z } from "zod/v3";

/**
 * Emits the span shape an OpenInference LLM instrumentation produces for a
 * chat completion, without needing an SDK or an API key: a wrapper span
 * containing an `openinference.*`/`llm.*`-attributed span.
 *
 * Prompt/response content is deliberately present even though the metadata
 * processor never extracts it (it's not on the allowlist); tests assert it
 * doesn't leak into step metadata.
 */
export function simulateOpenAICall(): string {
  const tracer = trace.getTracer(
    "@arizeai/openinference-instrumentation-openai",
  );
  return tracer.startActiveSpan("open-ai-wrapper", (wrapperSpan) => {
    try {
      return tracer.startActiveSpan(
        "open-ai-span",
        {
          attributes: {
            "openinference.span.kind": "LLM",
            "llm.model_name": "gpt-5.4-nano",
            "llm.token_count.prompt": 18,
            // Content attributes that must never reach step metadata.
            "input.value": "secret prompt",
            "output.value": "secret completion",
            "llm.input_messages.0.message.content": "secret",
          },
        },
        (span) => {
          span.end();
          return "done";
        },
      );
    } finally {
      wrapperSpan.end();
    }
  });
}

const fetchTraceStepsQuery = `
  query Query($runID: String!, $preview: Boolean) {
    run(runID: $runID) {
      trace(preview: $preview) {
        childrenSpans {
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

const traceStepSchema = z.object({
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

export function getAIMetadata(step: TraceStep | undefined) {
  if (!step) {
    return [];
  }

  return step.metadata.filter((metadata) => {
    return metadata.kind === "inngest.ai" && metadata.scope === "step";
  });
}
