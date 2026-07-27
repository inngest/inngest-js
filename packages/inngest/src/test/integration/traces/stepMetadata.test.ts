import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { expect } from "vitest";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { matrixCheckpointing } from "../utils.ts";
import {
  getAIMetadata,
  simulateOpenAICall,
  waitForTraceSteps,
} from "./util.ts";

// The metadata span processor is extend-only: the Inngest constructor attaches
// it to whatever global OTel provider already exists, and never creates one.
// Register a bare provider (no exporter needed) and a context manager before
// any client is constructed so the engine's execution spans are recorded and
// userland spans parent under them.
trace.setGlobalTracerProvider(new BasicTracerProvider());
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());

const testFileName = testNameFromFileUrl(import.meta.url);

// The fields the extractor lifts from `simulateOpenAICall`'s span, mapped to
// the server's snake_case `inngest.ai` schema. Content attributes are never
// extracted, and `total_tokens` is absent because the span carries no provider
// total (we never derive one). `latency_ms` is derived from span timing, so
// its exact value is non-deterministic and only asserted to be a number.
const expectedAIMetadata = {
  kind: "inngest.ai",
  scope: "step",
  values: {
    operation_name: "chat",
    request_model: "gpt-5.4-nano",
    response_model: "gpt-5.4-nano-2026-03-17",
    provider: "openai",
    input_tokens: 18,
    output_tokens: 39,
    latency_ms: expect.any(Number),
  },
};

matrixCheckpointing(
  "AI OTel attributes become step metadata",
  async (checkpointing) => {
    const state = createState();
    const eventName = randomSuffix("evt");
    const client = new Inngest({
      checkpointing,
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const fn = client.createFunction(
      {
        id: "fn-1",
        retries: 0,
        triggers: [{ event: eventName }],
      },
      async ({ runId, step }) => {
        state.runId = runId;
        await step.run("my-step", simulateOpenAICall);
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    const steps = await waitForTraceSteps(await state.waitForRunId());
    const step = steps.find((step) => {
      return step.name === "my-step" && hasAiMetadata(step.metadata);
    });

    expect(getAIMetadata(step)).toEqual([expectedAIMetadata]);
  },
);

matrixCheckpointing("multiple AI calls in a step", async (checkpointing) => {
  const state = createState();
  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    {
      id: "fn-1",
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ runId, step }) => {
      state.runId = runId;
      await step.run("my-step", () => {
        simulateOpenAICall();
        simulateOpenAICall();
      });
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  const steps = await waitForTraceSteps(await state.waitForRunId());
  const step = steps.find((step) => {
    return step.name === "my-step" && hasAiMetadata(step.metadata);
  });

  // Two calls in one step aggregate: token counts sum; model/system are kept.
  expect(getAIMetadata(step)).toEqual([
    {
      ...expectedAIMetadata,
      values: {
        ...expectedAIMetadata.values,
        input_tokens: 2 * expectedAIMetadata.values.input_tokens,
        output_tokens: 2 * expectedAIMetadata.values.output_tokens,
      },
    },
  ]);
});

matrixCheckpointing(
  "AI spans outside a step window are not attributed",
  async (checkpointing) => {
    const state = createState();
    const eventName = randomSuffix("evt");
    const client = new Inngest({
      checkpointing,
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const fn = client.createFunction(
      {
        id: "fn-1",
        retries: 0,
        triggers: [{ event: eventName }],
      },
      async ({ runId, step }) => {
        state.runId = runId;
        await step.run("ai-step", simulateOpenAICall);

        // Function-body spans end while no step is executing, so they must
        // not be attributed to any step — including the one about to start.
        simulateOpenAICall();

        await step.run("no-ai-step", () => "done");
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    const steps = await waitForTraceSteps(await state.waitForRunId());
    const aiStep = steps.find((step) => {
      return step.name === "ai-step" && hasAiMetadata(step.metadata);
    });
    const noAiStep = steps.find((step) => {
      return step.name === "no-ai-step";
    });

    expect(aiStep).toBeDefined();
    expect(noAiStep).toBeDefined();
    expect(getAIMetadata(aiStep)).toEqual([expectedAIMetadata]);
    expect(getAIMetadata(noAiStep)).toEqual([]);
  },
);

// Temporary workaround for intentionally duplicate step spans in Dev Server.
// TODO: Delete this once the duplicate step spans go away
function hasAiMetadata(metadata: { kind: string }[]) {
  for (const m of metadata) {
    if (m.kind === "inngest.ai") {
      return true;
    }
  }
  return false;
}

test("disable AI metadata", async () => {
  const state = createState();
  const eventName = randomSuffix("evt");
  const client = new Inngest({
    aiMetadata: false,
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    {
      id: "fn-1",
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ runId, step }) => {
      state.runId = runId;
      await step.run("my-step", simulateOpenAICall);
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // No AI metadata
  const steps = await waitForTraceSteps(await state.waitForRunId());
  for (const step of steps) {
    expect(getAIMetadata(step)).toEqual([]);
  }
});
