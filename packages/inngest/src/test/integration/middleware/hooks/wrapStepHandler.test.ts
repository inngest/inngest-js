import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect } from "vitest";
import { Inngest, Middleware, NonRetriableError } from "../../../../index.ts";
import { matrixCheckpointing } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

matrixCheckpointing("change output (2 middleware)", async (checkpointing) => {
  const state = createState({
    step: {
      insideCount: 0,
      output: "",
    },
  });

  class MW1 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
      const output = await next();
      return `mw1 transformed: ${output}`;
    }
  }

  class MW2 extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
      const output = await next();
      return `mw2 transformed: ${output}`;
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW1, MW2],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.step.output = await step.run("my-step", () => {
        state.step.insideCount++;
        return "original";
      });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.step).toEqual({
    insideCount: 1,
    output: "mw1 transformed: mw2 transformed: original",
  });
});

matrixCheckpointing("called once per attempt", async (checkpointing) => {
  const state = createState({
    hook: {
      callCount: 0,
      throwCount: 0,
    },
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
      state.hook.callCount++;
      try {
        return await next();
      } catch (error) {
        state.hook.throwCount++;
        throw error;
      }
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 2, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      await step.run("step-1", async () => {
        throw new Error("test error");
      });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.hook).toEqual({
    callCount: 3,
    throwCount: 3,
  });
});

matrixCheckpointing(
  "not called for memoized step outputs",
  async (checkpointing) => {
    const state = createState({
      stepIds: [] as string[],
    });

    class MW extends Middleware.BaseMiddleware {
      readonly id = "test";
      override async wrapStepHandler({
        next,
        stepInfo,
      }: Middleware.WrapStepHandlerArgs) {
        state.stepIds.push(stepInfo.options.id);
        return next();
      }
    }

    const eventName = randomSuffix("evt");
    const client = new Inngest({
      checkpointing,
      id: randomSuffix(testFileName),
      isDev: true,
      middleware: [MW],
    });
    const fn = client.createFunction(
      { id: "fn", retries: 0, triggers: [{ event: eventName }] },
      async ({ step, runId }) => {
        state.runId = runId;
        await step.run("step-before-sleep-1", async () => {});
        await step.run("step-before-sleep-2", async () => {});

        // Force reentry
        await step.sleep("zzz", "1s");

        await step.run("step-after-sleep-1", async () => {});
        await step.run("step-after-sleep-2", async () => {});
      },
    );
    await createTestApp({ client, functions: [fn] });

    await client.send({ name: eventName });
    await state.waitForRunComplete();

    expect(state.stepIds).toEqual([
      "step-before-sleep-1",
      "step-before-sleep-2",
      "step-after-sleep-1",
      "step-after-sleep-2",
    ]);
  },
);

matrixCheckpointing("swallow error", async (checkpointing) => {
  // Swallow a step handler error, so the step succeeds from the function
  // handler's perspective.

  const state = createState({
    hook: {
      count: 0,
    },
    step: {
      count: 0,
      output: "",
    },
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
      state.hook.count++;
      try {
        return await next();
      } catch {
        return "gulp";
      }
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 2, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      state.step.output = await step.run("step-1", async () => {
        state.step.count++;
        throw new Error("test error");
      });
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.hook).toEqual({ count: 1 });
  expect(state.step).toEqual({
    count: 1,
    output: "gulp",
  });
});

matrixCheckpointing("throw error", async (checkpointing) => {
  // Swallow a step's output and fail the step by throwing a
  // `NonRetriableError`.

  const state = createState({
    fn: {
      caughtErrors: [] as unknown[],
    },
    hook: {
      count: 0,
    },
    step: {
      count: 0,
      output: "" as unknown,
    },
  });

  class MW extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapStepHandler({ next }: Middleware.WrapStepHandlerArgs) {
      state.hook.count++;
      state.step.output = await next();
      throw new NonRetriableError("test error");
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    checkpointing,
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [MW],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 2, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      try {
        await step.run("step-1", async () => {
          state.step.count++;
          return "original";
        });
      } catch (error) {
        state.fn.caughtErrors.push(error);
        throw error;
      }
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunFailed();

  expect(state.fn.caughtErrors).toHaveLength(1);
  expect(state.hook).toEqual({ count: 1 });
  expect(state.step).toEqual({
    count: 1,
    output: "original",
  });
});
