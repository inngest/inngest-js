import { createState, testNameFromFileUrl } from "@inngest/test-harness";
import { expect, test } from "vitest";
import { stream } from "../../../experimental/durable-endpoints.ts";
import { step } from "../../../index.ts";
import { streamRun } from "../../../stream.ts";

import { setupEndpoint } from "./helpers.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("async mode", async (method) => {
  const state = createState({});
  const { port } = await setupEndpoint(testFileName, async () => {
    await step.run("a", async () => {
      stream.push("sync-data");
      return "a output";
    });
    await step.sleep("go-async", "1s");
    await step.run("b", async () => {
      stream.push("async-data");
      return "b output";
    });
    return Response.json("fn output");
  });

  const calls = {
    onData: [] as { data: unknown; hashedStepId?: string }[],
    onDone: [] as undefined[],
    onError: [] as undefined[],
    onFunctionCompleted: [] as { data: unknown }[],
    onFunctionFailed: [] as undefined[],
    onMetadata: [] as { runId: string }[],
    onRollback: [] as undefined[],
    onStepCompleted: [] as { hashedStepId: string }[],
    onStepErrored: [] as undefined[],
    onStepRunning: [] as { hashedStepId: string }[],
  };

  const rs = streamRun(`http://localhost:${port}/api/demo`, {
    onData: (args) => {
      calls.onData.push(args);
    },
    onDone: () => {
      calls.onDone.push(undefined);
    },
    onError: () => {
      calls.onError.push(undefined);
    },
    onFunctionCompleted: (args) => {
      calls.onFunctionCompleted.push(args);
    },
    onFunctionFailed: () => {
      calls.onFunctionFailed.push(undefined);
    },
    onMetadata: (args) => {
      calls.onMetadata.push(args);
      state.runId = args.runId;
    },
    onRollback: () => {
      calls.onRollback.push(undefined);
    },
    onStepCompleted: (args) => {
      calls.onStepCompleted.push(args);
    },
    onStepErrored: () => {
      calls.onStepErrored.push(undefined);
    },
    onStepRunning: (args) => {
      calls.onStepRunning.push(args);
    },
  });
  await rs;

  expect(calls).toEqual({
    onData: [
      {
        data: "sync-data",
        hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
      },
      {
        data: "async-data",
        hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
      },
    ],
    onDone: [undefined],
    onError: [],

    // FIXME: Should we parse this as JSON?
    onFunctionCompleted: [{ data: '"fn output"' }],

    onFunctionFailed: [],
    onMetadata: [
      { runId: expect.any(String) },
      { runId: expect.any(String) },
      { runId: expect.any(String) },
    ],
    onRollback: [],
    onStepCompleted: [
      { hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" },
      { hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" },
    ],
    onStepErrored: [],
    onStepRunning: [
      { hashedStepId: "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8" },
      { hashedStepId: "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98" },
    ],
  });

  await state.waitForRunComplete();
});
