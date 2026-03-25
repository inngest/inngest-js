/*
 * Integration tests that exercise the client-side `streamRun` API, including
 * `subscribeToRun` redirect following and frame parsing.
 */

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
    });
    await step.sleep("go-async", "1s");
    await step.run("b", async () => {
      stream.push("async-data");
    });
    return Response.json("done");
  });

  const chunks: unknown[] = [];
  const steps = {
    running: [] as string[],
    completed: [] as string[],
  };
  let result: unknown;

  const rs = streamRun(`http://localhost:${port}/api/demo`, {
    onData: (chunk) => {
      chunks.push(chunk);
    },
    onMetadata: (id) => {
      state.runId = id;
    },
    onStepRunning: (id) => {
      steps.running.push(id);
    },
    onStepCompleted: (id) => {
      steps.completed.push(id);
    },
    onFunctionSucceeded: (data) => {
      result = data;
    },
  });
  await rs;

  expect(chunks).toEqual(["sync-data", "async-data"]);
  expect(steps.running).toEqual([
    "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
    "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
  ]);
  expect(steps.completed).toEqual([
    "86f7e437faa5a7fce15d1ddcb9eaeaea377667b8",
    "e9d71f5ee7c92d6dc9e92ffdad17b8bd49418f98",
  ]);
  expect(result).toBe('"done"');

  await state.waitForRunComplete();
});
