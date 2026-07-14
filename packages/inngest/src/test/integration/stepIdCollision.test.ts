import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("terminal failure of a step named 'complete' is catchable", async () => {
  // A step may be named "complete"; its terminal failure must be catchable
  const state = createState({ caught: false });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const eventName = randomSuffix("evt");
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: { event: eventName } },
    async ({ runId, step }) => {
      state.runId = runId;
      try {
        await step.run("complete", () => {
          throw new Error("boom");
        });
      } catch {
        state.caught = true;
      }
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  await client.send({ name: eventName, data: {} });
  await state.waitForRunComplete();
  expect(state.caught).toBe(true);
});
