import { DEV_SERVER_URL, waitFor } from "@inngest/test-harness";
import { trace } from "@opentelemetry/api";
import { z } from "zod/v3";
import {
  aiMetadataKeys,
  aiMetadataKind,
} from "../../../components/execution/otel/metadataProcessor/metadata.ts";

const openAIInputTokens = 18;
const openAIOutputTokens = 39;
const openAIRequestModel = "gpt-5.4-nano";
const openAIResponseModel = "gpt-5.4-nano-2026-03-17";

export const openAIStepName = "lib-openai";
export const openAIStepMetadata = {
  kind: aiMetadataKind,
  scope: "step",
  values: {
    [aiMetadataKeys.inputTokens]: openAIInputTokens,
    [aiMetadataKeys.model]: openAIResponseModel,
    [aiMetadataKeys.outputTokens]: openAIOutputTokens,
  },
};

const traceMetadataSchema = z.object({
  kind: z.string(),
  scope: z.string(),
  updatedAt: z.string().nullable().optional(),
  values: z.record(z.unknown()),
});

export type RunTraceSpan = {
  childrenSpans: RunTraceSpan[];
  metadata: z.infer<typeof traceMetadataSchema>[];
  name: string;
};

const runTraceSpanSchema: z.ZodType<RunTraceSpan> = z.lazy(() =>
  z.object({
    childrenSpans: z.array(runTraceSpanSchema).default([]),
    metadata: z.array(traceMetadataSchema),
    name: z.string(),
  }),
);

const runTraceResponseSchema = z.object({
  data: z.object({
    run: z
      .object({
        trace: runTraceSpanSchema.nullable(),
      })
      .nullable(),
  }),
});

const getRunQuery = `query GetRun($runID: String!, $preview: Boolean) {
  run(runID: $runID) {
    trace(preview: $preview) {
      ...TraceDetails
      childrenSpans {
        ...TraceDetails
        childrenSpans {
          ...TraceDetails
          childrenSpans {
            ...TraceDetails
            childrenSpans {
              ...TraceDetails
            }
          }
        }
      }
    }
  }
}

fragment TraceDetails on RunTraceSpan {
  name
  metadata {
    scope
    kind
    values
    updatedAt
  }
}`;

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

export async function waitForRunTrace(runId: string): Promise<RunTraceSpan> {
  return waitFor(async () => {
    const runTrace = await fetchRunTrace(runId);
    if (!runTrace) {
      throw new Error("Run trace not found");
    }

    return runTrace;
  });
}

export function findSpanByName(
  span: RunTraceSpan,
  name: string,
): RunTraceSpan | undefined {
  if (span.name === name) {
    return span;
  }

  for (const child of span.childrenSpans) {
    const found = findSpanByName(child, name);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export function recordOpenAISpan(): string {
  const tracer = trace.getTracer("@opentelemetry/instrumentation-openai");
  return tracer.startActiveSpan(
    `chat ${openAIRequestModel}`,
    {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": openAIRequestModel,
        "gen_ai.response.model": openAIResponseModel,
        "gen_ai.system": "openai",
        "gen_ai.usage.input_tokens": openAIInputTokens,
        "gen_ai.usage.output_tokens": openAIOutputTokens,
      },
    },
    (span) => {
      span.end();
      return "done";
    },
  );
}

async function fetchRunTrace(runId: string): Promise<RunTraceSpan | null> {
  const res = await fetch(`${DEV_SERVER_URL}/v0/gql`, {
    body: JSON.stringify({
      operationName: "GetRun",
      query: getRunQuery,
      variables: { preview: true, runID: runId },
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  const parsed = runTraceResponseSchema.parse(await res.json());
  const run = parsed.data.run;
  if (!run) {
    return null;
  }

  return run.trace;
}
