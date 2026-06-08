import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import {
  findSpanByName,
  openAIStepMetadata,
  openAIStepName,
  recordOpenAISpan,
  waitForOtelProvider,
  waitForRunTrace,
} from "./util.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("step metadata comes back from GraphQL", async () => {
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
      await step.run(openAIStepName, recordOpenAISpan);
      return "done";
    },
  );

  await waitForOtelProvider();
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  const runTrace = await waitForRunTrace(await state.waitForRunId());
  const step = findSpanByName(runTrace, openAIStepName);
  if (!step) {
    throw new Error("OpenAI step trace not found");
  }

  expect(step.metadata).toContainEqual({
    ...openAIStepMetadata,
    updatedAt: expect.any(String),
  });
});
