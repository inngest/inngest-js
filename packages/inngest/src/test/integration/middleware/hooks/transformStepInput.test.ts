import { expect, test } from "vitest";
import { z } from "zod";
import { Inngest, invoke, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  anyContext,
  createState,
  randomSuffix,
  testNameFromFileUrl,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("args", () => {
  for (const level of ["client", "function"] as const) {
    test(`level: ${level}`, async () => {
      const state = createState({
        hookArgs: [] as Middleware.TransformStepInputArgs[],
      });

      class TestMiddleware extends Middleware.BaseMiddleware {
        readonly id = "test";
        override transformStepInput(
          arg: Middleware.TransformStepInputArgs,
        ): Middleware.TransformStepInputArgs {
          state.hookArgs.push(arg);
          return arg;
        }
      }

      let clientMiddleware: Middleware.Class[] = [];
      let functionMiddleware: Middleware.Class[] = [];
      if (level === "client") {
        clientMiddleware = [TestMiddleware];
      } else {
        functionMiddleware = [TestMiddleware];
      }

      const eventName = randomSuffix("evt");
      const client = new Inngest({
        id: randomSuffix(testFileName),
        isDev: true,
        middleware: clientMiddleware,
      });
      const fn = client.createFunction(
        {
          id: "fn",
          retries: 0,
          middleware: functionMiddleware,
          triggers: [{ event: eventName }],
        },
        async ({ step, runId }) => {
          state.runId = runId;
          await step.run("my-step", () => "result");
        },
      );
      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();

      // Called twice: once fresh (request 1), once memoized (request 2)
      expect(state.hookArgs).toEqual([
        {
          fn,
          stepInfo: {
            hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
            memoized: false,
            stepType: "run",
          },
          stepOptions: { id: "my-step", name: "my-step" },
          input: [],
        },
        {
          fn,
          stepInfo: {
            hashedId: "8376129f22207d6e1acaa1c92de099dcb1ba24db",
            memoized: true,
            stepType: "run",
          },
          stepOptions: { id: "my-step", name: "my-step" },
          input: [],
        },
      ]);
    });
  }
});

test("modify step.run input (1 middleware)", async () => {
  const state = createState({
    run: { input: 0 },
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      if (arg.stepInfo.stepType === "run") {
        return {
          ...arg,
          input: [42],
        };
      }
      return arg;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run(
        "my-step",
        (value: number) => {
          state.run.input = value;
          return value;
        },
        1,
      );
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.run).toEqual({ input: 42 });
});

test("modify step.run input (2 middleware, forward order)", async () => {
  const state = createState({
    run: { input: 0 },
  });

  class MW1 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      if (arg.stepInfo.stepType === "run") {
        return {
          ...arg,
          input: [(arg.input[0] as number) * 10],
        };
      }
      return arg;
    }
  }

  class MW2 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      if (arg.stepInfo.stepType === "run") {
        return {
          ...arg,
          input: [(arg.input[0] as number) + 5],
        };
      }
      return arg;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW1, MW2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run(
        "my-step",
        (value: number) => {
          state.run.input = value;
          return value;
        },
        1,
      );
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Forward order: MW1 runs first (* 10 = 10), then MW2 (+ 5 = 15)
  expect(state.run).toEqual({ input: 15 });
});

describe("change step ID", () => {
  test("new step ID", async () => {
    // Change a step ID after it already ran, so that the step is treated as
    // fresh again. This means the step runs twice, with a different ID each
    // time

    const state = createState({
      step1: {
        insideCount: 0,
        output: 0,
      },
      onStepStartCalls: [] as Middleware.OnStepStartArgs[],
    });

    let changeStepID = false;
    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override onStepStart(arg: Middleware.OnStepStartArgs) {
        state.onStepStartCalls.push(arg);
      }

      override transformStepInput(
        arg: Middleware.TransformStepInputArgs,
      ): Middleware.TransformStepInputArgs {
        if (changeStepID) {
          return {
            ...arg,
            stepOptions: {
              ...arg.stepOptions,
              id: "new",
            },
          };
        }
        changeStepID = true;
        return arg;
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: [{ event: eventName }],
      },
      async ({ step, runId }) => {
        state.step1.output = await step.run("step-1", () => {
          state.step1.insideCount++;
          return state.step1.insideCount;
        });
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.step1).toEqual({
      insideCount: 2,
      output: 2,
    });
    expect(state.onStepStartCalls).toEqual([
      {
        ctx: anyContext,
        fn,
        stepInfo: {
          hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
          input: undefined,
          memoized: false,
          options: { id: "step-1", name: "step-1" },
          stepType: "run",
        },
      },
      {
        ctx: anyContext,
        fn,
        stepInfo: {
          hashedId: "c2a6b03f190dfb2b4aa91f8af8d477a9bc3401dc",
          input: undefined,
          memoized: false,
          options: { id: "new", name: "step-1" },
          stepType: "run",
        },
      },
    ]);
  });

  test("existing", async () => {
    // Change a step ID after it already ran, so that the step is treated as
    // fresh again. This means the step runs twice, with a different ID each
    // time.
    //
    // The changed step ID is the same as a preexisting step ID, which will be
    // deduped (via the implicit index suffix). This test ensures we run thru
    // the step ID deduping logic after the middleware hook runs

    const state = createState({
      step1: {
        insideCount: 0,
        output: 0,
      },
      step2: {
        insideCount: 0,
        output: 0,
      },
      onStepStartCalls: [] as Middleware.OnStepStartArgs[],
    });

    let changeStepID = false;
    class TestMiddleware extends Middleware.BaseMiddleware {
      readonly id = "test";
      override onStepStart(arg: Middleware.OnStepStartArgs) {
        state.onStepStartCalls.push(arg);
      }

      override transformStepInput(
        arg: Middleware.TransformStepInputArgs,
      ): Middleware.TransformStepInputArgs {
        if (arg.stepOptions.id === "step-2") {
          if (changeStepID) {
            return {
              ...arg,
              stepOptions: {
                ...arg.stepOptions,
                id: "step-1",
              },
            };
          }
          changeStepID = true;
        }
        return arg;
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      {
        id: "fn",
        retries: 0,
        triggers: [{ event: eventName }],
      },
      async ({ step, runId }) => {
        state.step1.output = await step.run("step-1", () => {
          state.step1.insideCount++;
          return state.step1.insideCount;
        });

        state.step2.output = await step.run("step-2", () => {
          state.step2.insideCount++;
          return state.step2.insideCount;
        });
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.step1).toEqual({
      insideCount: 1,
      output: 1,
    });
    expect(state.step2).toEqual({
      insideCount: 2,
      output: 2,
    });

    expect(state.onStepStartCalls).toEqual([
      {
        ctx: anyContext,
        fn,
        stepInfo: {
          hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
          input: undefined,
          memoized: false,
          options: { id: "step-1", name: "step-1" },
          stepType: "run",
        },
      },
      {
        ctx: anyContext,
        fn,
        stepInfo: {
          hashedId: "e64b25e67dec6c8d30e63029286ad7b6d263931d",
          input: undefined,
          memoized: false,
          options: { id: "step-2", name: "step-2" },
          stepType: "run",
        },
      },
      {
        ctx: anyContext,
        fn,
        stepInfo: {
          hashedId: "853cb1e68d4c9c2ad16aabbef8c346b559cbb55c",
          input: undefined,
          memoized: false,
          options: {
            // TODO: Stop exposing the "implicit index suffix" imeplementation
            // detail
            id: "step-1:1",

            name: "step-2",
          },
          stepType: "run",
        },
      },
    ]);
  });
});

test("modify all step kinds", async () => {
  const state = createState({
    invoke: { input: 0 },
    run: { input: 0 },
    sleep: {
      afterTime: null as Date | null,
      beforeTime: null as Date | null,
    },
    sleepUntil: {
      afterTime: null as Date | null,
      beforeTime: null as Date | null,
    },
    waitForEvent: {
      afterTime: null as Date | null,
      beforeTime: null as Date | null,
    },
    unmemoizedCounts: {} as Record<Middleware.StepType, number>,
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      if (!arg.stepInfo.memoized) {
        state.unmemoizedCounts[arg.stepInfo.stepType] ??= 0;
        state.unmemoizedCounts[arg.stepInfo.stepType]++;
      }

      if (arg.stepInfo.stepType === "invoke") {
        return {
          ...arg,
          input: [
            {
              // @ts-expect-error - input is unknown[]
              ...arg.input[0],
              payload: {
                // @ts-expect-error - input is unknown[]
                ...arg.input[0].payload,
                data: { value: 2 },
              },
            },
          ],
        };
      } else if (arg.stepInfo.stepType === "run") {
        return {
          ...arg,
          input: [2],
        };
      } else if (arg.stepInfo.stepType === "sleep") {
        return {
          ...arg,
          input: ["1s"],
        };
      } else if (arg.stepInfo.stepType === "waitForEvent") {
        return {
          ...arg,
          input: [
            {
              // @ts-expect-error - input is unknown[]
              ...arg.input[0],
              timeout: "1s",
            },
          ],
        };
      }
      return arg;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.invoke("invoke", { function: childFn, data: { value: 1 } });

      await step.run(
        "run",
        (value: number) => {
          state.run.input = value;
          return value;
        },
        1,
      );

      state.sleep.beforeTime ??= new Date();
      await step.sleep("sleep", "60s");
      state.sleep.afterTime ??= new Date();

      state.sleepUntil.beforeTime ??= new Date();
      await step.sleepUntil("sleep-until", new Date(Date.now() + 60000));
      state.sleepUntil.afterTime ??= new Date();

      state.waitForEvent.beforeTime ??= new Date();
      await step.waitForEvent("wait-for-event", {
        event: randomSuffix("never"),
        timeout: "60s",
      });
      state.waitForEvent.afterTime ??= new Date();
    },
  );
  const childFn = client.createFunction(
    {
      id: "child",
      retries: 0,
      triggers: [invoke(z.object({ value: z.number() }))],
    },
    async ({ event }) => {
      state.invoke.input = event.data.value;
    },
  );
  await createTestApp({ client, functions: [fn, childFn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.invoke).toEqual({ input: 2 });

  // Middleware overrode the `step.run` input
  expect(state.run).toEqual({ input: 2 });

  // Middleware overrode the `step.sleep` duration
  const sleepDur =
    state.sleep.afterTime!.getTime() - state.sleep.beforeTime!.getTime();
  expect(sleepDur).toBeGreaterThan(900);
  expect(sleepDur).toBeLessThan(1500);

  // Middleware overrode the `step.sleepUntil` duration
  const sleepUntilDur =
    state.sleepUntil.afterTime!.getTime() -
    state.sleepUntil.beforeTime!.getTime();
  expect(sleepUntilDur).toBeGreaterThan(900);
  expect(sleepUntilDur).toBeLessThan(1500);

  // Middleware overrode the `step.waitForEvent` timeout
  const waitForEventDur =
    state.waitForEvent.afterTime!.getTime() -
    state.waitForEvent.beforeTime!.getTime();
  expect(waitForEventDur).toBeGreaterThan(900);
  expect(waitForEventDur).toBeLessThan(1500);

  expect(state.unmemoizedCounts).toEqual({
    invoke: 1,
    run: 1,

    // `step.sleepUntil` has the same stepType as `step.sleep`
    sleep: 2,

    waitForEvent: 1,
  });
});

test("called for memoized and fresh", async () => {
  const state = createState({
    calls: [] as { id: string; memoized: boolean }[],
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      state.calls.push({
        id: arg.stepOptions.id,
        memoized: arg.stepInfo.memoized,
      });
      return arg;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run("step-1", async () => "result-1");
      await step.run("step-2", async () => "result-2");
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.calls).toEqual([
    { id: "step-1", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: true },
  ]);
});
