/*
 * Non-streaming executions must not allocate the underlying Web Streams
 * objects for `StreamTools`. Eager per-execution `TransformStream` allocation
 * is a regression (https://github.com/inngest/inngest-js/issues/1624).
 */

import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest } from "../../index.ts";
import { createServer } from "../../node.ts";
import { trackStreamAllocations } from "../helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("a function run that never streams does not allocate a stream", async () => {
  const state = createState({});

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ runId, step }) => {
      state.runId = runId;
      await step.run("a", () => "result");
      return "done";
    },
  );
  await createTestApp({ client, functions: [fn], serve: createServer });

  const getStreamAllocations = trackStreamAllocations();

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(getStreamAllocations()).toEqual([]);
});
