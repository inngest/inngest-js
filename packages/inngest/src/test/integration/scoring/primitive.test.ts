import {
  createState,
  createTestApp,
  getRunTraceMetadata,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { scoreMiddleware } from "../../../experimental.ts";
import { Inngest } from "../../../index.ts";
import { createServer } from "../../../node.ts";
import {
  expectNoScoreValue,
  expectNoSpanByName,
  expectScoreValue,
  findSpanByName,
} from "./utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("client.score", async () => {
  test("outside function", async () => {
    const state = createState({});

    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ runId, step }) => {
        state.runId = runId;
        await step.run("my-step", () => {});
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName, data: {} });
    await state.waitForRunComplete();

    const runId = await state.waitForRunId();

    // Score run
    await client.score({ runId, name: "run_score", value: true });

    // Score step
    await client.score({
      name: "step_score",
      runId,
      stepId: "my-step",
      value: false,
    });

    const trace = await getRunTraceMetadata(runId);

    // Run
    expectScoreValue(trace.metadata, "run_score", true);
    expectNoScoreValue(trace.metadata, "step_score");

    // Step
    const step = findSpanByName(trace, "my-step");
    expectScoreValue(step.metadata, "step_score", false);
    expectNoScoreValue(step.metadata, "run_score");
  });

  test("inside step.run", async () => {
    const state = createState({});

    const client = new Inngest({
      checkpointing: true,
      id: randomSuffix(testFileName),
      isDev: true,
    });
    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ runId, step }) => {
        state.runId = runId;
        await step.run("my-step", async () => {
          // Score run
          await client.score({
            runId,
            name: "run_score",
            value: 1,
          });

          // Score step
          await client.score({
            runId,
            stepId: "my-step",
            name: "step_score",
            value: 2,
          });
        });
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName, data: {} });
    await state.waitForRunComplete();
    const trace = await getRunTraceMetadata(await state.waitForRunId());

    // Run
    expectScoreValue(trace.metadata, "run_score", 1);
    expectNoScoreValue(trace.metadata, "step_score");

    // Step
    const step = findSpanByName(trace, "my-step");
    expectScoreValue(step.metadata, "step_score", 2);
    expectNoScoreValue(step.metadata, "run_score");
  });

  test("non-existent step", async () => {
    // Error when scoring a step that doesn't exist

    const state = createState({
      error: null as unknown,
    });

    const client = new Inngest({
      checkpointing: true,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [scoreMiddleware()],
    });
    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ runId, step }) => {
        state.runId = runId;
        await step.run("my-step", async () => {
          try {
            await client.score({
              name: "step_score",
              runId,
              stepId: "non-existent",
              value: 2,
            });
          } catch (err) {
            state.error = err;
            throw err;
          }
        });
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName, data: {} });
    const output = await state.waitForRunFailed();
    expect(output).toEqual({
      message: "Failed to update metadata: Unable to find metadata target",
      name: "Error",
    });

    expect(state.error).toBeInstanceOf(Error);
    const error = state.error as Error;
    expect(error.message).toEqual(
      "Failed to update metadata: Unable to find metadata target",
    );
  });
});

describe("step.score", async () => {
  test("happy", async () => {
    const state = createState({});

    const client = new Inngest({
      checkpointing: true,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [scoreMiddleware()],
    });
    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ runId, step }) => {
        state.runId = runId;
        await step.run("my-step", () => {});

        // Score run
        await step.score("run-score", { name: "run_score", value: true });

        // Score step
        await step.score("step-score", {
          name: "step_score",
          stepId: "my-step",
          value: false,
        });
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName, data: {} });
    await state.waitForRunComplete();
    const trace = await getRunTraceMetadata(await state.waitForRunId());

    findSpanByName(trace, "run-score");
    findSpanByName(trace, "step-score");
    expectNoSpanByName(trace, "score:run-score");
    expectNoSpanByName(trace, "score:step-score");

    // Run
    expectScoreValue(trace.metadata, "run_score", true);
    expectNoScoreValue(trace.metadata, "step_score");

    // Step
    const step = findSpanByName(trace, "my-step");
    expectScoreValue(step.metadata, "step_score", false);
    expectNoScoreValue(step.metadata, "run_score");
  });

  test("non-existent step", async () => {
    // Error when scoring a step that doesn't exist

    const state = createState({
      error: null as unknown,
    });

    const client = new Inngest({
      checkpointing: true,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [scoreMiddleware()],
    });
    const eventName = randomSuffix("evt");
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: { event: eventName },
      },
      async ({ runId, step }) => {
        state.runId = runId;
        await step.run("my-step", () => {});

        try {
          await step.score("step-score", {
            name: "step_score",
            stepId: "non-existent",
            value: 2,
          });
        } catch (err) {
          state.error = err;
          throw err;
        }
      },
    );
    await createTestApp({ client, functions: [fn], serve: createServer });

    await client.send({ name: eventName, data: {} });
    const output = await state.waitForRunFailed();
    expect(output).toEqual({
      message: "Failed to update metadata: Unable to find metadata target",
      name: "Error",
    });

    expect(state.error).toBeInstanceOf(Error);
    const error = state.error as Error;
    expect(error.message).toEqual(
      "Failed to update metadata: Unable to find metadata target",
    );
  });
});
