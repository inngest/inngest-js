import {
  createState,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect, onTestFinished, test } from "vitest";
import { ConnectionState, connect } from "../../../connect.ts";
import { Inngest } from "../../../index.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("function with steps runs and completes via connect", async () => {
  const state = createState();

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      const a = await step.run("step-a", () => "hello");
      const b = await step.run("step-b", () => `${a} world`);
      return b;
    },
  );

  const connection = await connect({
    apps: [{ client, functions: [fn] }],
    handleShutdownSignals: [],
    isolateExecution: false,
  });
  onTestFinished(async () => {
    await connection.close();
  });
  await waitFor(() => {
    expect(connection.state).toBe(ConnectionState.ACTIVE);
  });

  await client.send({ name: eventName });

  const result = await state.waitForRunComplete();
  expect(result).toBe("hello world");
});
