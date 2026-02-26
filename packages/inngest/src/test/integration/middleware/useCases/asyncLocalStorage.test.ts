import { AsyncLocalStorage } from "node:async_hooks";
import {
  createState,
  createTestApp,
  randomSuffix,
  testNameFromFileUrl,
} from "@inngest/test-harness";
import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../../index.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("async local storage context via wrapFunctionHandler", async () => {
  // Use middleware to wrap the function handler in ALS context

  interface RunContext {
    msg: string;
  }

  const state = createState({
    contextsInFunction: [] as RunContext[],
  });

  const asyncLocalStorage = new AsyncLocalStorage<RunContext>();

  class AsyncLocalStorageMiddleware extends Middleware.BaseMiddleware {
    readonly id = "test";
    override async wrapFunctionHandler({
      next,
    }: Middleware.WrapFunctionHandlerArgs) {
      return asyncLocalStorage.run({ msg: "hi" }, next);
    }
  }

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [AsyncLocalStorageMiddleware],
  });
  const fn = client.createFunction(
    { id: "fn", retries: 0, triggers: [{ event: eventName }] },
    async ({ step, runId }) => {
      state.runId = runId;
      const context = asyncLocalStorage.getStore();
      if (!context) {
        throw new Error("missing context");
      }
      state.contextsInFunction.push(context);

      await step.run("step-1", () => {});
      await step.run("step-2", () => {});
    },
  );
  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  // Verify context was available at function level
  expect(state.contextsInFunction).toEqual([
    { msg: "hi" },
    { msg: "hi" },
    { msg: "hi" },
  ]);
});
