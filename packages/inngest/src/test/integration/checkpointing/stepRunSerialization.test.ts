import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("step.run output is JSON serialized even when checkpointed", async () => {
  // We created this test after discovering that `step.run` could return
  // non-JSON data during checkpointing

  const date = "2026-02-03T00:00:00.000Z";
  const state = createState({
    outputs: [] as unknown[],
    requestCount: 0,
  });

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId, step }) => {
      state.runId = runId;
      state.requestCount++;
      const output = await step.run("date-step", () => ({
        date: new Date(date),
        list: [new Date(date)],
        nested: { date: new Date(date) },
      }));

      state.outputs.push(output);
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName });
  await state.waitForRunComplete();
  expect(state.requestCount).toEqual(1);
  expect(state.outputs).toEqual([
    {
      date,
      list: [date],
      nested: { date },
    },
  ]);
});
