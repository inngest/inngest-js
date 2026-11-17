import {
  createState,
  createTestApp,
  randomSuffix,
  sleep,
  testNameFromFileUrl,
  waitFor,
} from "@inngest/test-harness";
import { expect } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import { matrixCheckpointing, spyLogger } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

matrixCheckpointing("step.sendSignal step type", async (checkpointing) => {
  const state = createState({
    sent: null as { runId: string | undefined } | null,
    stepTypes: {} as Record<string, string>,
    waiterRunId: null as string | null,
    received: null as { signal: string; data: unknown } | null,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      state.stepTypes[arg.stepOptions.id] = arg.stepInfo.stepType;
      return arg;
    }
  }

  const internalLogger = spyLogger();
  const signal = randomSuffix("signal");
  const waitEventName = randomSuffix("evt-wait");
  const sendEventName = randomSuffix("evt-send");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    internalLogger: internalLogger as never,
    isDev: true,
    middleware: [TestMiddleware],
  });

  const waiter = client.createFunction(
    {
      id: "waiter",
      retries: 0,
      triggers: [{ event: waitEventName }],
    },
    async ({ step, runId }) => {
      state.waiterRunId = runId;
      state.received = await step.waitForSignal("wait", {
        signal,
        timeout: "30s",
        onConflict: "fail",
      });
    },
  );
  const sender = client.createFunction(
    {
      id: "sender",
      retries: 0,
      triggers: [{ event: sendEventName }],
    },
    async ({ step, runId }) => {
      state.sent = await step.sendSignal("send", {
        signal,
        data: { foo: "bar" },
      });
      state.runId = runId;
    },
  );
  await createTestApp({
    client,
    functions: [waiter, sender],
    serve: createServer,
  });

  await client.send({ name: waitEventName });
  const waiterRunId = await waitFor(async () => {
    if (state.waiterRunId === null) {
      throw new Error("waiter has not started");
    }
    return state.waiterRunId;
  });

  // the Dev Server saves the signal wait after the waiter request returns.
  // a signal sent before that matches no run.
  await sleep(2000);

  await client.send({ name: sendEventName });
  await state.waitForRunComplete();

  expect(state.sent).toEqual({ runId: waiterRunId });
  await waitFor(async () => {
    expect(state.received).toEqual({
      signal,
      data: { foo: "bar" },
    });
  });

  expect(state.stepTypes).toEqual({
    send: "sendSignal",
    wait: "waitForSignal",
  });
  expect(internalLogger.warn).not.toHaveBeenCalledWith(
    expect.anything(),
    "Unknown step type",
  );
});
