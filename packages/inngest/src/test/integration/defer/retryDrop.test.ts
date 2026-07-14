import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { createDefer } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("defer registered inside a retried step closure still ships", async () => {
  // A defer buffered inside a step closure that succeeds on a retry attempt
  // must still ship with that response: the step is memoized by it, so the
  // closure never re-runs and this is the defer's only chance to ship.

  const parentState = createState({});
  const deferState = createState({ counter: 0 });

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    checkpointing: true,
  });
  const eventName = randomSuffix("evt");
  const foo = createDefer(client, { id: "foo" }, async ({ runId }) => {
    deferState.runId = runId;
    deferState.counter++;
  });
  const fn = client.createFunction(
    {
      id: "fn",
      retries: 1,
      triggers: { event: eventName },
    },
    async ({ attempt, defer, runId, step }) => {
      parentState.runId = runId;
      await step.run("flaky", async () => {
        defer("foo", { function: foo, data: {} });
        if (attempt === 0) {
          throw new Error("first attempt fails");
        }
      });
    },
  );
  await createTestApp({
    client,
    functions: [fn, foo],
    serve: createServer,
  });

  await client.send({ name: eventName, data: {} });
  await parentState.waitForRunComplete();
  await deferState.waitForRunComplete();

  // Wait long enough to give a 2nd defer a chance to trigger (it shouldn't)
  await sleep(5000);
  expect(deferState.counter).toBe(1);
});
