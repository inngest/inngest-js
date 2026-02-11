import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { createState, randomSuffix, testNameFromFileUrl } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("function-level middleware only on that function", async () => {
  const fnWithMwState = createState({});
  const fnWithoutMwState = createState({});
  let count = 0;

  class MW extends Middleware.BaseMiddleware {
    override onRunStart() {
      count++;
    }
  }

  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });
  const fnWithMwEventName = randomSuffix("evt");
  const fnWithMw = client.createFunction(
    {
      id: "fn-1",
      retries: 0,
      middleware: [MW],
    },
    { event: fnWithMwEventName },
    async ({ runId }) => {
      fnWithMwState.runId = runId;
    },
  );
  const fnWithoutMwEventName = randomSuffix("evt");
  const fnWithoutMw = client.createFunction(
    {
      id: "fn-2",
      retries: 0,
    },
    { event: fnWithoutMwEventName },
    async ({ runId }) => {
      fnWithoutMwState.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fnWithMw, fnWithoutMw] });

  await client.send({ name: fnWithoutMwEventName });
  await client.send({ name: fnWithMwEventName });
  await fnWithMwState.waitForRunComplete();
  await fnWithoutMwState.waitForRunComplete();
  expect(count).toEqual(1);
});
