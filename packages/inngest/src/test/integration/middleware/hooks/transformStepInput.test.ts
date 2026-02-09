import { expect, test } from "vitest";
import { z } from "zod";
import { Inngest, invoke, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import {
  anyContext,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("modify step.run input (1 middleware)", async () => {
  const state = {
    done: false,
    run: { input: 0 },
  };

  class MW extends Middleware.BaseMiddleware {
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      if (arg.stepInfo.stepKind === "run") {
        arg.input = [42];
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      await step.run(
        "my-step",
        (value: number) => {
          state.run.input = value;
          return value;
        },
        1,
      );
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.run).toEqual({ input: 42 });
});

test("modify step.run input (2 middleware, forward order)", async () => {
  const state = {
    done: false,
    run: { input: 0 },
  };

  class MW1 extends Middleware.BaseMiddleware {
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      if (arg.stepInfo.stepKind === "run") {
        arg.input = [(arg.input[0] as number) * 10];
      }
      return arg;
    }
  }

  class MW2 extends Middleware.BaseMiddleware {
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      if (arg.stepInfo.stepKind === "run") {
        arg.input = [(arg.input[0] as number) + 5];
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      await step.run(
        "my-step",
        (value: number) => {
          state.run.input = value;
          return value;
        },
        1,
      );
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  // Forward order: MW1 runs first (* 10 = 10), then MW2 (+ 5 = 15)
  expect(state.run).toEqual({ input: 15 });
});

test("modify step options (change step ID)", async () => {
  const state = {
    done: false,
    step1: {
      insideCount: 0,
      output: 0,
    },
    onStepStartCalls: [] as Middleware.OnStepStartArgs[],
  };

  let changeStepID = false;
  class MW extends Middleware.BaseMiddleware {
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
    async ({ step }) => {
      state.step1.output = await step.run("step-1", () => {
        state.step1.insideCount++;
        return state.step1.insideCount;
      });
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

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

test("modify all step kinds", async () => {
  const state = {
    done: false,
    invoke: { input: 0 },
    run: { input: 0 },
    sleep: {
      afterTime: null as Date | null,
      beforeTime: null as Date | null,
    },
    waitForEvent: {
      afterTime: null as Date | null,
      beforeTime: null as Date | null,
    },
  };

  class MW extends Middleware.BaseMiddleware {
    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
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
    async ({ step }) => {
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

      state.waitForEvent.beforeTime ??= new Date();
      await step.waitForEvent("wait-for-event", {
        event: randomSuffix("never"),
        timeout: "60s",
      });
      state.waitForEvent.afterTime ??= new Date();

      state.done = true;
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
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.invoke).toEqual({ input: 2 });
  expect(state.run).toEqual({ input: 2 });

  const sleepDur =
    state.sleep.afterTime!.getTime() - state.sleep.beforeTime!.getTime();
  expect(sleepDur).toBeGreaterThan(900);
  expect(sleepDur).toBeLessThan(1500);

  const waitForEventDur =
    state.waitForEvent.afterTime!.getTime() -
    state.waitForEvent.beforeTime!.getTime();
  expect(waitForEventDur).toBeGreaterThan(900);
  expect(waitForEventDur).toBeLessThan(1500);
});

test("called for memoized and fresh", async () => {
  const state = {
    done: false,
    calls: [] as { id: string; memoized: boolean }[],
  };

  class MW extends Middleware.BaseMiddleware {
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
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      await step.run("step-1", async () => "result-1");
      await step.run("step-2", async () => "result-2");
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.calls).toEqual([
    { id: "step-1", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: false },
    { id: "step-1", memoized: true },
    { id: "step-2", memoized: true },
  ]);
});
