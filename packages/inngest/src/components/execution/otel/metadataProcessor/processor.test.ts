import type { Span } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import type { Inngest } from "../../../Inngest.ts";
import { type AsyncContext, getAsyncLocalStorage } from "../../als.ts";
import { InngestAIMetadataSpanProcessor } from "./processor.ts";

const createSpan = ({
  spanId,
  parentSpanId,
  name = "ai.generateText",
  instrumentationScopeName = "ai",
  attributes = {},
}: {
  spanId: string;
  parentSpanId?: string;
  name?: string;
  instrumentationScopeName?: string;
  attributes?: ReadableSpan["attributes"];
}) =>
  ({
    attributes: {
      "operation.name": name,
      "ai.operationId": name,
      ...attributes,
    },
    instrumentationScope: { name: instrumentationScopeName },
    name,
    parentSpanContext: parentSpanId ? { spanId: parentSpanId } : undefined,
    setAttribute: vi.fn(),
    spanContext: () => ({ spanId }),
  }) as unknown as Span & ReadableSpan;

const createClient = () =>
  ({
    updateMetadata: vi.fn().mockResolvedValue(undefined),
  }) as unknown as Inngest.Any;

const runWithExecutionContext = async (
  {
    addMetadata,
    attempt = 0,
    client,
    headers,
    runId = "run-1",
    stepId = "step-1",
  }: {
    addMetadata: ReturnType<typeof vi.fn>;
    attempt?: number;
    client: Inngest.Any;
    headers?: Record<string, string>;
    runId?: string;
    stepId?: string;
  },
  fn: () => void,
) => {
  const als = await getAsyncLocalStorage();
  als.run(
    {
      app: client,
      execution: {
        ctx: { attempt, runId },
        executingStep: { id: stepId },
        instance: { addMetadata, headers },
      },
    } as AsyncContext,
    fn,
  );
};

describe("InngestAIMetadataSpanProcessor", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("batches allowlisted AI span attributes as step metadata", async () => {
    const client = createClient();
    const processor = new InngestAIMetadataSpanProcessor(client);
    const addMetadata = vi.fn(() => true);
    const root = createSpan({ spanId: "root" });
    const aiSpan = createSpan({
      spanId: "ai-span",
      parentSpanId: "root",
      attributes: {
        "ai.model.id": "gpt-4o-mini",
        "ai.usage.inputTokens": 15,
        "ai.usage.outputTokens": 21,
        "ai.usage.totalTokens": 36,
      },
    });

    await runWithExecutionContext({ addMetadata, attempt: 2, client }, () => {
      processor.declareStartingSpan({
        span: root,
        runId: "run-1",
        traceparent: undefined,
        tracestate: undefined,
      });
      processor.onStart(aiSpan);
      processor.onEnd(aiSpan);
    });

    expect(addMetadata).toHaveBeenCalledWith(
      "step-1",
      "inngest.ai",
      "step",
      "merge",
      {
        "input-tokens": 15,
        "model-id": "gpt-4o-mini",
        "output-tokens": 21,
      },
    );
  });

  test("sends metadata via API when the current step context is gone", async () => {
    const client = createClient();
    const processor = new InngestAIMetadataSpanProcessor(client);
    const addMetadata = vi.fn(() => true);
    const root = createSpan({ spanId: "root" });
    const aiSpan = createSpan({
      spanId: "ai-span",
      parentSpanId: "root",
      attributes: {
        "ai.model.id": "gpt-4o-mini",
        "ai.usage.inputTokens": 10,
      },
    });

    await runWithExecutionContext(
      {
        addMetadata,
        attempt: 1,
        client,
        headers: { "x-inngest-env": "branch" },
      },
      () => {
        processor.declareStartingSpan({
          span: root,
          runId: "run-1",
          traceparent: undefined,
          tracestate: undefined,
        });
        processor.onStart(aiSpan);
      },
    );

    processor.onEnd(aiSpan);

    await vi.waitFor(() => {
      expect(client["updateMetadata"]).toHaveBeenCalledWith({
        headers: { "x-inngest-env": "branch" },
        metadata: [
          {
            kind: "inngest.ai",
            op: "merge",
            values: {
              "input-tokens": 10,
              "model-id": "gpt-4o-mini",
            },
          },
        ],
        target: {
          run_id: "run-1",
          step_attempt: 1,
          step_id: "step-1",
        },
      });
    });

    expect(addMetadata).not.toHaveBeenCalled();
  });

  test("ignores spans without allowlisted AI metadata", async () => {
    const client = createClient();
    const processor = new InngestAIMetadataSpanProcessor(client);
    const addMetadata = vi.fn(() => true);
    const root = createSpan({ spanId: "root" });
    const span = createSpan({
      spanId: "regular-span",
      parentSpanId: "root",
      attributes: {
        "ai.usage.totalTokens": 36,
      },
    });

    await runWithExecutionContext({ addMetadata, client }, () => {
      processor.declareStartingSpan({
        span: root,
        runId: "run-1",
        traceparent: undefined,
        tracestate: undefined,
      });
      processor.onStart(span);
      processor.onEnd(span);
    });

    expect(addMetadata).not.toHaveBeenCalled();
    expect(client["updateMetadata"]).not.toHaveBeenCalled();
  });

  test("ignores internal AI child spans with duplicate usage metadata", async () => {
    const client = createClient();
    const processor = new InngestAIMetadataSpanProcessor(client);
    const addMetadata = vi.fn(() => true);
    const root = createSpan({ spanId: "root" });
    const topLevelSpan = createSpan({
      spanId: "ai-span",
      parentSpanId: "root",
      name: "ai.generateText",
      attributes: {
        "ai.model.id": "gpt-4o-mini",
        "ai.usage.inputTokens": 15,
        "ai.usage.outputTokens": 21,
      },
    });
    const internalSpan = createSpan({
      spanId: "ai-internal-span",
      parentSpanId: "ai-span",
      name: "ai.generateText.doGenerate",
      attributes: {
        "ai.model.id": "gpt-4o-mini",
        "ai.operationId": "ai.generateText",
        "ai.usage.inputTokens": 15,
        "ai.usage.outputTokens": 21,
      },
    });

    await runWithExecutionContext({ addMetadata, client }, () => {
      processor.declareStartingSpan({
        span: root,
        runId: "run-1",
        traceparent: undefined,
        tracestate: undefined,
      });
      processor.onStart(topLevelSpan);
      processor.onStart(internalSpan);
      processor.onEnd(internalSpan);
      processor.onEnd(topLevelSpan);
    });

    expect(addMetadata).toHaveBeenCalledTimes(1);
    expect(addMetadata).toHaveBeenCalledWith(
      "step-1",
      "inngest.ai",
      "step",
      "merge",
      {
        "input-tokens": 15,
        "model-id": "gpt-4o-mini",
        "output-tokens": 21,
      },
    );
  });

  test("preserves one metadata update per top-level AI span", async () => {
    const client = createClient();
    const processor = new InngestAIMetadataSpanProcessor(client);
    const addMetadata = vi.fn(() => true);
    const root = createSpan({ spanId: "root" });
    const aiSpan1 = createSpan({
      spanId: "ai-span-1",
      parentSpanId: "root",
      attributes: { "ai.usage.inputTokens": 5 },
    });
    const aiSpan2 = createSpan({
      spanId: "ai-span-2",
      parentSpanId: "root",
      attributes: { "ai.usage.inputTokens": 8 },
    });

    await runWithExecutionContext({ addMetadata, client }, () => {
      processor.declareStartingSpan({
        span: root,
        runId: "run-1",
        traceparent: undefined,
        tracestate: undefined,
      });
      processor.onStart(aiSpan1);
      processor.onEnd(aiSpan1);
      processor.onStart(aiSpan2);
      processor.onEnd(aiSpan2);
    });

    expect(addMetadata).toHaveBeenNthCalledWith(
      1,
      "step-1",
      "inngest.ai",
      "step",
      "merge",
      { "input-tokens": 5 },
    );
    expect(addMetadata).toHaveBeenNthCalledWith(
      2,
      "step-1",
      "inngest.ai",
      "step",
      "merge",
      { "input-tokens": 8 },
    );
  });
});
