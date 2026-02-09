import { AsyncLocalStorage } from "node:async_hooks";
import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";
import { createTestApp } from "../../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl, waitFor } from "../../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("async local storage context via wrapFunctionHandler", async () => {
  // Use middleware to wrap the function handler in ALS context

  interface RunContext {
    msg: string;
  }

  const state = {
    contextsInFunction: [] as RunContext[],
    done: false,
  };

  const asyncLocalStorage = new AsyncLocalStorage<RunContext>();

  class AsyncLocalStorageMiddleware extends Middleware.BaseMiddleware {
    override wrapFunctionHandler = async (next: () => Promise<unknown>) => {
      return asyncLocalStorage.run({ msg: "hi" }, next);
    };
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [AsyncLocalStorageMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      const context = asyncLocalStorage.getStore();
      if (!context) {
        throw new Error("missing context");
      }
      state.contextsInFunction.push(context);

      await step.run("step-1", () => {});
      await step.run("step-2", () => {});
      state.done = true;
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  // Verify context was available at function level
  expect(state.contextsInFunction).toEqual([
    { msg: "hi" },
    { msg: "hi" },
    { msg: "hi" },
  ]);
});
