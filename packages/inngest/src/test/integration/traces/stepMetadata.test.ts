import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { extendedTracesMiddleware } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { matrixCheckpointing } from "../utils.ts";
import {
  simulateOpenAICall,
  type TraceStep,
  waitForOtelProvider,
  waitForTraceSteps,
} from "./util.ts";

const testFileName = testNameFromFileUrl(import.meta.url);
const expectedAIMetadata = {
  kind: "inngest.ai",
  scope: "step",
  values: {
    "input-tokens": 18,
    model: "gpt-5.4-nano-2026-03-17",
    "output-tokens": 39,
  },
};

const getAIMetadata = (step: TraceStep | undefined) => {
  if (!step) {
    return [];
  }

  return step.metadata.filter((metadata) => {
    return metadata.kind === "inngest.ai" && metadata.scope === "step";
  });
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
        return "done";
      },
    );
    await waitForOtelProvider();
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    const steps = await waitForTraceSteps(await state.waitForRunId());
    const step = steps.find((step) => step.name === "my-step");

    expect(getAIMetadata(step)).toEqual([expectedAIMetadata]);
  },
);

matrixCheckpointing(
  "Extended Traces and OTel attribute extraction are compatible",
  async (checkpointing) => {
    // When Extended Traces is enabled, OTel attribute extraction works exactly
    // the same and also the span appears.

    const state = createState();
    const eventName = randomSuffix("evt");
    const client = new Inngest({
      checkpointing,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [extendedTracesMiddleware()],
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
        return "done";
      },
    );
    await waitForOtelProvider();
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    const runId = await state.waitForRunId();
    const steps = await waitForTraceSteps(runId);
    const step = steps.find((step) => step.name === "my-step");

    // Extended Traces userland spans appear as child spans under the step.
    expect(step?.childrenSpans).toEqual([
      {
        isUserland: true,
        name: "open-ai-span",
      },
    ]);

    expect(getAIMetadata(step)).toEqual([expectedAIMetadata]);
  },
);
