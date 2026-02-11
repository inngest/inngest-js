import { expect, test } from "vitest";
import { z } from "zod";
import {
  type Context,
  Inngest,
  invoke,
  Middleware,
} from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  anyContext,
  assertStepError,
  createState,
  isRecord,
  randomSuffix,
  testNameFromFileUrl,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("output", async () => {
  test("1 middleware", async () => {
    const state = createState({
      hook: {
        outputs: [] as unknown[],
      },
      step: {
        insideCount: 0,
        output: "",
      },
    });

    class MW extends Middleware.BaseMiddleware {
      override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
        next,
        { stepInfo },
      ) => {
        const output = await next();
        state.hook.outputs.push(output);
        if (stepInfo.memoized) {
          return output;
        }

        return `wrapped: ${output}`;
      };
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async ({ step, runId }) => {
        state.step.output = await step.run("my-step", async () => {
          state.step.insideCount++;
          return "original";
        });
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.hook.outputs).toEqual(["original", "wrapped: original"]);
    expect(state.step).toEqual({
      insideCount: 1,
      output: "wrapped: original",
    });
  });

  test("2 middleware", async () => {
    const state = createState({
      hook: {
        outputs: [] as unknown[],
      },
      step: {
        insideCount: 0,
        output: "",
      },
    });

    class MW1 extends Middleware.BaseMiddleware {
      override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
        next,
        { stepInfo },
      ) => {
        const output = await next();
        state.hook.outputs.push(output);
        if (stepInfo.memoized) {
          return output;
        }

        return `mw1: ${output}`;
      };
    }

    class MW2 extends Middleware.BaseMiddleware {
      override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
        next,
        { stepInfo },
      ) => {
        const output = await next();
        state.hook.outputs.push(output);
        if (stepInfo.memoized) {
          return output;
        }

        return `mw2: ${output}`;
      };
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW1, MW2],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async ({ step, runId }) => {
        state.step.output = await step.run("my-step", async () => {
          state.step.insideCount++;
          return "original";
        });
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.hook.outputs).toEqual([
      "original",
      "mw2: original",
      "mw1: mw2: original",
      "mw1: mw2: original",
    ]);
    expect(state.step).toEqual({
      insideCount: 1,
      output: "mw1: mw2: original",
    });
  });
});

describe("error", async () => {
  class InsideStepError extends Error {
    constructor(message: string) {
      super(message);
      this.name = this.constructor.name;
    }
  }

  class InsideMWError extends Error {
    constructor(...args: Parameters<typeof Error>) {
      super(...args);
      this.name = this.constructor.name;
    }
  }

  test("1 middleware", async () => {
    const state = createState({
      mw: {
        errors: [] as unknown[],
      },
      step: {
        insideCount: 0,
        error: null as unknown,
      },
    });

    class MW extends Middleware.BaseMiddleware {
      override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
        next,
        { stepInfo },
      ) => {
        try {
          await next();
        } catch (error) {
          state.mw.errors.push(error);
          if (stepInfo.memoized) {
            throw error;
          }
          throw new InsideMWError("wrapped", { cause: error });
        }
      };
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async ({ step, runId }) => {
        try {
          await step.run("my-step", async () => {
            state.step.insideCount++;
            throw new InsideStepError("original");
          });
        } catch (error) {
          console.log("caught", error);
          state.step.error = error;
        }
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.mw.errors).toHaveLength(2);
    expect(state.mw.errors[0]).toEqual(new InsideStepError("original"));
    assertStepError(state.mw.errors[1], {
      message: "original",
      name: "InsideStepError",
    });

    expect(state.step).toEqual({
      insideCount: 1,
      error: state.mw.errors[1],
    });
  });

  test("2 middleware", async () => {
    const state = createState({
      mw1: {
        errors: [] as unknown[],
      },
      mw2: {
        errors: [] as unknown[],
      },
      step: {
        insideCount: 0,
        error: null as unknown,
      },
    });

    class MW1 extends Middleware.BaseMiddleware {
      override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
        next,
        { stepInfo },
      ) => {
        try {
          await next();
        } catch (error) {
          state.mw1.errors.push(error);
          if (stepInfo.memoized) {
            throw error;
          }
          throw new InsideMWError("mw1", { cause: error });
        }
      };
    }

    class MW2 extends Middleware.BaseMiddleware {
      override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
        next,
        { stepInfo },
      ) => {
        try {
          await next();
        } catch (error) {
          state.mw2.errors.push(error);
          if (stepInfo.memoized) {
            throw error;
          }
          throw new InsideMWError("mw2", { cause: error });
        }
      };
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW1, MW2],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
      async ({ step, runId }) => {
        try {
          await step.run("my-step", async () => {
            state.step.insideCount++;
            throw new InsideStepError("original");
          });
        } catch (error) {
          console.log("caught", error);
          state.step.error = error;
        }
        state.runId = runId;
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    // MW2 catches error first
    expect(state.mw2.errors).toHaveLength(2);
    expect(state.mw2.errors[0]).toEqual(new InsideStepError("original"));
    assertStepError(state.mw2.errors[1], {
      message: "original",
      name: "InsideStepError",
    });

    // MW1 catches error second
    expect(state.mw1.errors).toHaveLength(2);
    expect(state.mw1.errors[0]).toEqual(
      new InsideMWError("mw2", { cause: new InsideStepError("original") }),
    );
    assertStepError(state.mw1.errors[1], {
      message: "original",
      name: "InsideStepError",
    });

    expect(state.step).toEqual({
      insideCount: 1,
      error: state.mw1.errors[1],
    });
  });
});

test("wrap step handler", async () => {
  const state = createState({
    handlerWrapped: false,
    stepResult: null as unknown,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapStep(next: () => Promise<unknown>) {
      state.handlerWrapped = true;
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step, runId }) => {
      state.stepResult = await step.run("my-step", async () => {
        return "step result";
      });
      state.runId = runId;
      return "function result";
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.handlerWrapped).toBe(true);
  expect(state.stepResult).toBe("step result");
});

test("multiple middleware in correct order (reverse/wrapping)", async () => {
  const state = createState({
    logs: [] as string[],
  });

  class Mw1 extends Middleware.BaseMiddleware {
    override async wrapStep(next: () => Promise<unknown>) {
      state.logs.push("mw1 before");
      const result = await next();
      state.logs.push("mw1 after");
      return result;
    }
  }

  class Mw2 extends Middleware.BaseMiddleware {
    override async wrapStep(next: () => Promise<unknown>) {
      state.logs.push("mw2 before");
      const result = await next();
      state.logs.push("mw2 after");
      return result;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [Mw1, Mw2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step, runId }) => {
      await step.run("my-step", async () => {
        state.logs.push("step executed");
        return "result";
      });
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Input transforms wrap in reverse order: mw1 is outermost, mw2 is innermost
  // So execution order is: mw1 before -> mw2 before -> step -> mw2 after -> mw1 after
  expect(state.logs).toEqual([
    "mw1 before",
    "mw2 before",
    "step executed",
    "mw2 after",
    "mw1 after",
    "mw1 before",
    "mw2 before",
    "mw2 after",
    "mw1 after",
  ]);
});

test("called when both fresh and memoized", async () => {
  const state = createState({
    inputCalls: [] as { id: string; memoized: boolean }[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
      next,
      { stepInfo },
    ) => {
      state.inputCalls.push({
        id: stepInfo.options.id,
        memoized: stepInfo.memoized,
      });
      return next();
    };
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step, runId }) => {
      await step.run("step-1", async () => "result-1");
      await step.run("step-2", async () => "result-2");
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.inputCalls).toEqual([
    { id: "step-1", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: true },
  ]);
});

describe("change step ID", async () => {
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
      override onStepStart(arg: Middleware.OnStepStartArgs) {
        state.onStepStartCalls.push(arg);
      }

      override transformStepInput(
        arg: Middleware.TransformStepInputArgs,
      ): Middleware.TransformStepInputArgs {
        if (changeStepID) {
          arg.stepOptions.id = "new";
        } else {
          changeStepID = true;
        }
        return arg;
      }

      override wrapStep(next: () => Promise<unknown>) {
        return next();
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
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
        stepInfo: {
          hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
          input: undefined,
          memoized: false,
          options: { id: "step-1", name: "step-1" },
          stepKind: "run",
        },
      },
      {
        ctx: anyContext,
        stepInfo: {
          hashedId: "c2a6b03f190dfb2b4aa91f8af8d477a9bc3401dc",
          input: undefined,
          memoized: false,
          options: { id: "new", name: "step-1" },
          stepKind: "run",
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
      override onStepStart(arg: Middleware.OnStepStartArgs) {
        state.onStepStartCalls.push(arg);
      }

      override transformStepInput(
        arg: Middleware.TransformStepInputArgs,
      ): Middleware.TransformStepInputArgs {
        if (arg.stepOptions.id === "step-2") {
          if (changeStepID) {
            arg.stepOptions.id = "step-1";
          } else {
            changeStepID = true;
          }
        }
        return arg;
      }

      override wrapStep(next: () => Promise<unknown>) {
        return next();
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [TestMiddleware],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0 },
      { event: eventName },
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
        stepInfo: {
          hashedId: "cd59ee9a8137151d1499d3d2eb40ba51aa91e0aa",
          input: undefined,
          memoized: false,
          options: { id: "step-1", name: "step-1" },
          stepKind: "run",
        },
      },
      {
        ctx: anyContext,
        stepInfo: {
          hashedId: "e64b25e67dec6c8d30e63029286ad7b6d263931d",
          input: undefined,
          memoized: false,
          options: { id: "step-2", name: "step-2" },
          stepKind: "run",
        },
      },
      {
        ctx: anyContext,
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
          stepKind: "run",
        },
      },
    ]);
  });
});

test("bookend step.sleep", async () => {
  // Run a step before a `step.sleep` in the Inngest function

  const state = createState({
    afterStep: {
      insideCount: 0,
      output: 0,
    },
    beforeStep: {
      insideCount: 0,
      output: 0,
    },
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override onStepStart(arg: Middleware.OnStepStartArgs) {
      state.onStepStartCalls.push(arg);
    }

    override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
      next,
      { stepInfo, ctx },
    ) => {
      if (stepInfo.options.id.endsWith("-prepend")) {
        return next();
      }

      const prependStepId = stepInfo.options.id + "-prepend";

      state.beforeStep.output = await ctx.step.run(prependStepId, async () => {
        state.beforeStep.insideCount++;
        return state.beforeStep.insideCount;
      });

      // The normal step
      const output = await next();

      state.afterStep.output = await ctx.step.run(prependStepId, async () => {
        state.afterStep.insideCount++;
        return state.afterStep.insideCount;
      });
      return output;
    };
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.sleep("zzz", "1s");
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.beforeStep).toEqual({
    insideCount: 1,
    output: 1,
  });

  expect(state.afterStep).toEqual({
    insideCount: 1,
    output: 1,
  });
});

test("bookend with steps", async () => {
  // Run a step before and after the normal step in the Inngest function

  const state = createState({
    afterStep: {
      insideCount: 0,
      output: 0,
    },
    beforeStep: {
      insideCount: 0,
      output: 0,
    },
    normalStep: {
      insideCount: 0,
      output: 0,
    },
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
      next,
      { stepInfo, ctx },
    ) => {
      if (["before", "after"].includes(stepInfo.options.id)) {
        return next();
      }

      state.beforeStep.output = await ctx.step.run("before", async () => {
        state.beforeStep.insideCount++;
        return state.beforeStep.insideCount;
      });

      // The normal step
      const output = await next();

      state.afterStep.output = await ctx.step.run("after", async () => {
        state.afterStep.insideCount++;
        return state.afterStep.insideCount;
      });
      return output;
    };
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step, runId }) => {
      state.normalStep.output = await step.run("step-1", () => {
        state.normalStep.insideCount++;
        return state.normalStep.insideCount;
      });
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.beforeStep).toEqual({
    insideCount: 1,
    output: 1,
  });
  expect(state.normalStep).toEqual({
    insideCount: 1,
    output: 1,
  });
  expect(state.afterStep).toEqual({
    insideCount: 1,
    output: 1,
  });
});

test("change step input", async () => {
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
    unmemoizedCounts: {} as Record<Middleware.StepKind, number>,
  });

  class TestMiddleware extends Middleware.BaseMiddleware {
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      if (!arg.stepInfo.memoized) {
        state.unmemoizedCounts[arg.stepInfo.stepKind] ??= 0;
        state.unmemoizedCounts[arg.stepInfo.stepKind]++;
      }

      if (arg.stepInfo.stepKind === "invoke") {
        // @ts-expect-error - input is unknown[]
        arg.input[0].payload.data = { value: 2 };
      } else if (arg.stepInfo.stepKind === "run") {
        arg.input = [2];
      } else if (arg.stepInfo.stepKind === "sleep") {
        arg.input = ["1s"];
      } else if (arg.stepInfo.stepKind === "waitForEvent") {
        // @ts-expect-error - input is unknown[]
        arg.input[0].timeout = "1s";
      }

      return arg;
    }

    override wrapStep(next: () => Promise<unknown>) {
      return next();
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [TestMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
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
    { id: "child", retries: 0 },
    invoke(z.object({ value: z.number() })),
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

    // `step.sleepUntil` has the same stepKind as `step.sleep`
    sleep: 2,

    waitForEvent: 1,
  });
});

test("2 middleware with staticTransform", async () => {
  // Ensure that both output modification and staticTransform are applied in
  // reverse order

  // Replace the "mw1" and "mwBoth" fields
  type ReplaceMW1Fields<T> = {
    [K in keyof T]: K extends "mw1" | "mwBoth" ? "replaced by mw1" : T[K];
  };
  interface MW1StaticTransform extends Middleware.StaticTransform {
    Out: ReplaceMW1Fields<this["In"]>;
  }
  class MW1 extends Middleware.BaseMiddleware {
    declare staticTransform: MW1StaticTransform;

    override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
      next,
      { stepInfo },
    ) => {
      const output = await next();
      if (stepInfo.memoized) {
        return output;
      }
      if (!isRecord(output)) {
        return output;
      }

      return {
        ...output,
        mw1: "replaced by mw1",
        mwBoth: "replaced by mw1",
      };
    };
  }

  // Replace the "mw2" and "mwBoth" fields
  type ReplaceMW2Fields<T> = {
    [K in keyof T]: K extends "mw2" | "mwBoth" ? "replaced by mw2" : T[K];
  };
  interface MW2StaticTransform extends Middleware.StaticTransform {
    Out: ReplaceMW2Fields<this["In"]>;
  }

  class MW2 extends Middleware.BaseMiddleware {
    declare staticTransform: MW2StaticTransform;

    override wrapStep: Middleware.BaseMiddleware["wrapStep"] = async (
      next,
      { stepInfo },
    ) => {
      const output = await next();
      if (stepInfo.memoized) {
        return output;
      }
      if (!isRecord(output)) {
        return output;
      }

      return {
        ...output,
        mw2: "replaced by mw2",
        mwBoth: "replaced by mw2",
      };
    };
  }

  const state = createState({
    output: null as ExpectedFinalOutput | null,
  });

  type ExpectedFinalOutput = {
    readonly mw1: "replaced by mw1";
    readonly mw2: "replaced by mw2";
    readonly mwBoth: "replaced by mw1";
    readonly mwNone: "original";
  };

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW1, MW2],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step, runId }) => {
      const output = await step.run("my-step", () => {
        return {
          mw1: "original",
          mw2: "original",
          mwBoth: "original",
          mwNone: "original",
        } as const;
      });
      expectTypeOf(output).not.toBeAny();
      expectTypeOf(output).toEqualTypeOf<ExpectedFinalOutput>();

      state.output = output;
      state.runId = runId;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Runtime values match `ExpectedFinalOutput`
  expect(state.output).toEqual({
    mw1: "replaced by mw1",
    mw2: "replaced by mw2",
    mwBoth: "replaced by mw1",
    mwNone: "original",
  });
});
