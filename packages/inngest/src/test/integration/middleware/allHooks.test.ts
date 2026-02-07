import { expect, test } from "vitest";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import { randomSuffix, testNameFromFileUrl, waitFor } from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

test("all hooks fire in correct order with 2 middleware", async () => {
  const state = {
    done: false,
    logs: [] as string[],
  };

  function createMW(name: string) {
    return class extends Middleware.BaseMiddleware {
      override transformClientInput(arg: Middleware.TransformClientInputArgs) {
        state.logs.push(`transformClientInput (${name})`);
        return arg.input;
      }

      override wrapRequest(): Middleware.WrapRequestReturn {
        return async ({ next }) => {
          state.logs.push(`wrapRequest: before (${name})`);
          const res = await next();
          state.logs.push(`wrapRequest: after (${name})`);
          return res;
        };
      }

      override transformFunctionInput(
        arg: Middleware.TransformFunctionInputArgs,
      ) {
        state.logs.push(`transformFunctionInput (${name})`);
        return arg;
      }

      override onMemoizationEnd() {
        state.logs.push(`onMemoizationEnd (${name})`);
      }

      override wrapFunctionHandler(): Middleware.WrapFunctionHandlerReturn {
        return async ({ next }) => {
          state.logs.push(`wrapFunctionHandler: before (${name})`);
          const result = await next();
          state.logs.push(`wrapFunctionHandler: after (${name})`);
          return result;
        };
      }

      override wrapStep(
        stepInfo: Middleware.StepInfo,
      ): Middleware.WrapStepReturn {
        return async ({ next, stepOptions, input }) => {
          state.logs.push(
            `wrapStep(${stepInfo.memoized ? "memo" : "fresh"}): before (${name})`,
          );
          const result = await next({ stepOptions, input });
          state.logs.push(
            `wrapStep(${stepInfo.memoized ? "memo" : "fresh"}): after (${name})`,
          );
          return result;
        };
      }

      override onStepStart() {
        state.logs.push(`onStepStart (${name})`);
      }

      override onStepEnd() {
        state.logs.push(`onStepEnd (${name})`);
      }

      override onStepError() {
        state.logs.push(`onStepError (${name})`);
      }
    };
  }

  const Mw1 = createMW("mw1");
  const Mw2 = createMW("mw2");

  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    middleware: [Mw1, Mw2],
  });

  const fn = client.createFunction(
    { id: "fn", retries: 0 },
    { event: eventName },
    async ({ step }) => {
      state.logs.push("fn: top");
      await step.run("my-step", () => {
        state.logs.push("step: inside");
        return "result";
      });
      state.logs.push("fn: bottom");
      state.done = true;
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await waitFor(async () => {
    expect(state.done).toBe(true);
  });

  expect(state.logs).toEqual([
    // client.send() - forward order
    "transformClientInput (mw1)",
    "transformClientInput (mw2)",

    // --- Request 1: fresh step discovered and executed ---
    "wrapRequest: before (mw1)",
    "wrapRequest: before (mw2)",
    "transformFunctionInput (mw1)",
    "transformFunctionInput (mw2)",
    "onMemoizationEnd (mw1)", // Fires immediately (no memoized state)
    "onMemoizationEnd (mw2)",
    "wrapFunctionHandler: before (mw1)",
    "wrapFunctionHandler: before (mw2)",
    "fn: top",
    "wrapStep(fresh): before (mw1)",
    "wrapStep(fresh): before (mw2)",
    "onStepStart (mw1)",
    "onStepStart (mw2)",
    "step: inside",
    "wrapStep(fresh): after (mw2)", // Onion unwind
    "wrapStep(fresh): after (mw1)",
    "onStepEnd (mw1)", // Fires after wrapStep resolves (observes transformed output)
    "onStepEnd (mw2)",
    // NOTE: wrapFunctionHandler "after" does NOT fire here. Step discovery
    // interrupts the function via control flow, so next() in
    // wrapFunctionHandler never resolves. Use try/finally for cleanup.
    "wrapRequest: after (mw2)",
    "wrapRequest: after (mw1)",

    // --- Request 2: memoized step, function completes ---
    "wrapRequest: before (mw1)",
    "wrapRequest: before (mw2)",
    "transformFunctionInput (mw1)",
    "transformFunctionInput (mw2)",
    "wrapFunctionHandler: before (mw1)",
    "wrapFunctionHandler: before (mw2)",
    "fn: top",
    "onMemoizationEnd (mw1)",
    "onMemoizationEnd (mw2)",
    "wrapStep(memo): before (mw1)",
    "wrapStep(memo): before (mw2)",
    "wrapStep(memo): after (mw2)",
    "wrapStep(memo): after (mw1)",
    "fn: bottom",
    "wrapFunctionHandler: after (mw2)", // Only unwinds when function completes
    "wrapFunctionHandler: after (mw1)",
    "wrapRequest: after (mw2)",
    "wrapRequest: after (mw1)",
  ]);
});
