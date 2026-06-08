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
import {
  simulateOpenAICall,
  waitForOtelProvider,
  waitForSteps,
} from "./util.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("AI OTel attributes become step metadata", async () => {
  const state = createState();
  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing: false,
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

  const steps = await waitForSteps(await state.waitForRunId());
  const step = steps.find((step) => step.name === "my-step");

  // AI metadata exists
  expect(step?.metadata).toContainEqual({
    kind: "inngest.ai",
    scope: "step",
    values: {
      "input-tokens": 18,
      model: "gpt-5.4-nano-2026-03-17",
      "output-tokens": 39,
    },
  });
});

test.only("Extended Traces and OTel attribute extraction are compatible", async () => {
  // When Extended Traces is enabled, OTel attribute extraction works exactly
  // the same and also the span appears.

  const state = createState();
  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing: false,
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
  const steps = await waitForSteps(runId);
  const step = steps.find((step) => step.name === "my-step");

  // Extended Trace exists
  expect(step?.childrenSpans).toEqual([
    {
      isUserland: true,
      name: "open-ai-span",
    },
  ]);

  // AI metadata exists
  expect(step?.metadata).toContainEqual({
    kind: "inngest.ai",
    scope: "step",
    values: {
      "input-tokens": 18,
      model: "gpt-5.4-nano-2026-03-17",
      "output-tokens": 39,
    },
  });
});
