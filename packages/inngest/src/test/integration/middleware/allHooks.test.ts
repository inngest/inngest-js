import { describe, expect, test } from "vitest";
import type { MiddlewareClass } from "../../../components/middleware/middleware.ts";
import { Inngest, Middleware } from "../../../index.ts";
import { createTestApp } from "../../devServerTestHarness.ts";
import {
  createState,
  randomSuffix,
  testNameFromFileUrl,
  waitFor,
} from "../utils.ts";

const testFileName = testNameFromFileUrl(import.meta.url);

describe("all hooks fire in correct order with 2 middleware", () => {
  const levels = [
    "client", // Only client middleware
    "function", // Only function middleware
    "mixed", // Client and function middleware
  ] as const;
  for (const level of levels) {
    test(level, async () => {
      const state = createState({
        logs: [] as string[],
      });

      function createMW(name: string) {
        return class extends Middleware.BaseMiddleware {
          static override onRegister() {
            state.logs.push(`onRegister (${name})`);
          }

          override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
            state.logs.push(`transformSendEvent (${name})`);
            return arg.events;
          }

          override async wrapSendEvent({ next }: Middleware.WrapSendEventArgs) {
            state.logs.push(`wrapSendEvent: before (${name})`);
            const result = await next();
            state.logs.push(`wrapSendEvent: after (${name})`);
            return result;
          }

          override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
            state.logs.push(`wrapRequest: before (${name})`);
            const res = await next();
            state.logs.push(`wrapRequest: after (${name})`);
            return res;
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

          override async wrapFunctionHandler({
            next,
          }: Middleware.WrapFunctionHandlerArgs) {
            state.logs.push(`wrapFunctionHandler: before (${name})`);
            const result = await next();
            state.logs.push(`wrapFunctionHandler: after (${name})`);
            return result;
          }

          override transformStepInput(
            arg: Middleware.TransformStepInputArgs,
          ): Middleware.TransformStepInputArgs {
            state.logs.push(
              `transformStepInput(${arg.stepInfo.memoized ? "memo" : "fresh"}) (${name})`,
            );
            return arg;
          }

          override wrapStep = async ({
            next,
            stepInfo,
          }: Middleware.WrapStepArgs) => {
            state.logs.push(
              `wrapStep(${stepInfo.memoized ? "memo" : "fresh"}): before (${name})`,
            );
            const result = await next();
            state.logs.push(
              `wrapStep(${stepInfo.memoized ? "memo" : "fresh"}): after (${name})`,
            );
            return result;
          };

          override onStepStart() {
            state.logs.push(`onStepStart (${name})`);
          }

          override onStepComplete() {
            state.logs.push(`onStepComplete (${name})`);
          }

          override onStepError() {
            state.logs.push(`onStepError (${name})`);
          }

          override onRunStart() {
            state.logs.push(`onRunStart (${name})`);
          }

          override onRunComplete() {
            state.logs.push(`onRunComplete (${name})`);
          }

          override onRunError() {
            state.logs.push(`onRunError (${name})`);
          }
        };
      }

      const Mw1 = createMW("mw1");
      const Mw2 = createMW("mw2");

      let clientMiddleware: MiddlewareClass[] = [];
      if (level === "client") {
        clientMiddleware = [Mw1, Mw2];
      } else if (level === "mixed") {
        clientMiddleware = [Mw1];
      }

      let functionMiddleware: MiddlewareClass[] = [];
      if (level === "function") {
        functionMiddleware = [Mw1, Mw2];
      } else if (level === "mixed") {
        functionMiddleware = [Mw2];
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
          state.logs.push("fn: top");
          await step.run("my-step", () => {
            state.logs.push("step: inside");
            return "result";
          });
          state.logs.push("fn: bottom");
        },
      );

      await createTestApp({ client, functions: [fn] });

      await client.send({ name: eventName });
      await state.waitForRunComplete();

      expect(state.logs).toEqual([
        "onRegister (mw1)",
        "onRegister (mw2)",

        // client.send() - forward order
        "transformSendEvent (mw1)",
        "transformSendEvent (mw2)",
        "wrapSendEvent: before (mw1)",
        "wrapSendEvent: before (mw2)",
        "wrapSendEvent: after (mw2)",
        "wrapSendEvent: after (mw1)",

        // --- Request 1: fresh step discovered and executed ---
        "wrapRequest: before (mw1)",
        "wrapRequest: before (mw2)",
        "transformFunctionInput (mw1)",
        "transformFunctionInput (mw2)",
        "onMemoizationEnd (mw1)", // Fires immediately (no memoized state)
        "onMemoizationEnd (mw2)",
        "onRunStart (mw1)",
        "onRunStart (mw2)",
        "wrapFunctionHandler: before (mw1)",
        "wrapFunctionHandler: before (mw2)",
        "fn: top",
        "transformStepInput(fresh) (mw1)", // Forward order, before wrapStep
        "transformStepInput(fresh) (mw2)",
        "wrapStep(fresh): before (mw1)",
        "wrapStep(fresh): before (mw2)",
        "onStepStart (mw1)",
        "onStepStart (mw2)",
        "step: inside",
        "wrapStep(fresh): after (mw2)", // Onion unwind
        "wrapStep(fresh): after (mw1)",
        "onStepComplete (mw1)", // Fires after wrapStep resolves (observes transformed output)
        "onStepComplete (mw2)",
        // NOTE: wrapFunctionHandler "after" does NOT fire here. Step discovery
        // interrupts the function via control flow, so next() in
        // wrapFunctionHandler never resolves. Use try/finally for cleanup.
        // onRunComplete does NOT fire here either (interrupted).
        "wrapRequest: after (mw2)",
        "wrapRequest: after (mw1)",

        // --- Request 2: memoized step, function completes ---
        "wrapRequest: before (mw1)",
        "wrapRequest: before (mw2)",
        "transformFunctionInput (mw1)",
        "transformFunctionInput (mw2)",
        // onRunStart does NOT fire here (memoized steps present)
        "wrapFunctionHandler: before (mw1)",
        "wrapFunctionHandler: before (mw2)",
        "fn: top",
        "transformStepInput(memo) (mw1)", // Forward order, before wrapStep
        "transformStepInput(memo) (mw2)",
        "onMemoizationEnd (mw1)", // Fires after all memoized steps seen
        "onMemoizationEnd (mw2)",
        "wrapStep(memo): before (mw1)",
        "wrapStep(memo): before (mw2)",
        "wrapStep(memo): after (mw2)",
        "wrapStep(memo): after (mw1)",
        "fn: bottom",
        "wrapFunctionHandler: after (mw2)", // Only unwinds when function completes
        "wrapFunctionHandler: after (mw1)",
        "onRunComplete (mw1)",
        "onRunComplete (mw2)",
        "wrapRequest: after (mw2)",
        "wrapRequest: after (mw1)",
      ]);
    });
  }
});

test("all hooks fire in correct order with checkpointing", async () => {
  const state = createState({
    logs: [] as string[],
  });

  class MW extends Middleware.BaseMiddleware {
    static override onRegister() {
      state.logs.push(`onRegister`);
    }

    override transformSendEvent(arg: Middleware.TransformSendEventArgs) {
      state.logs.push(`transformSendEvent`);
      return arg.events;
    }

    override async wrapSendEvent({ next }: Middleware.WrapSendEventArgs) {
      state.logs.push(`wrapSendEvent: before`);
      const result = await next();
      state.logs.push(`wrapSendEvent: after`);
      return result;
    }

    override async wrapRequest({ next }: Middleware.WrapRequestArgs) {
      state.logs.push(`wrapRequest: before`);
      const res = await next();
      state.logs.push(`wrapRequest: after`);
      return res;
    }

    override transformFunctionInput(
      arg: Middleware.TransformFunctionInputArgs,
    ) {
      state.logs.push(`transformFunctionInput`);
      return arg;
    }

    override onMemoizationEnd() {
      state.logs.push(`onMemoizationEnd`);
    }

    override async wrapFunctionHandler({
      next,
    }: Middleware.WrapFunctionHandlerArgs) {
      state.logs.push(`wrapFunctionHandler: before`);
      const result = await next();
      state.logs.push(`wrapFunctionHandler: after`);
      return result;
    }

    override transformStepInput(
      arg: Middleware.TransformStepInputArgs,
    ): Middleware.TransformStepInputArgs {
      state.logs.push(
        `transformStepInput(${arg.stepInfo.memoized ? "memo" : "fresh"})`,
      );
      return arg;
    }

    override wrapStep = async ({ next, stepInfo }: Middleware.WrapStepArgs) => {
      state.logs.push(
        `wrapStep(${stepInfo.memoized ? "memo" : "fresh"}): before`,
      );
      const result = await next();
      state.logs.push(
        `wrapStep(${stepInfo.memoized ? "memo" : "fresh"}): after`,
      );
      return result;
    };

    override onStepStart() {
      state.logs.push(`onStepStart`);
    }

    override onStepComplete() {
      state.logs.push(`onStepComplete`);
    }

    override onStepError() {
      state.logs.push(`onStepError`);
    }

    override onRunStart() {
      state.logs.push(`onRunStart`);
    }

    override onRunComplete() {
      state.logs.push(`onRunComplete`);
    }

    override onRunError() {
      state.logs.push(`onRunError`);
    }
  }
  const eventName = randomSuffix("evt");
  const client = new Inngest({
    id: randomSuffix(testFileName),
    isDev: true,
    checkpointing: true,
    middleware: [MW],
  });

  const fn = client.createFunction(
    {
      id: "fn",
      retries: 0,
      triggers: [{ event: eventName }],
    },
    async ({ step, runId }) => {
      state.runId = runId;
      state.logs.push("fn: top");
      await step.run("my-step", () => {
        state.logs.push("step: inside");
        return "result";
      });
      state.logs.push("fn: bottom");
    },
  );

  await createTestApp({ client, functions: [fn] });

  await client.send({ name: eventName });
  await state.waitForRunComplete();

  expect(state.logs).toEqual([
    "onRegister",

    // client.send() - forward order
    "transformSendEvent",
    "wrapSendEvent: before",
    "wrapSendEvent: after",

    // --- Single request: step executed, checkpointed, function completes ---
    // With checkpointing, the step executes and its result is checkpointed
    // back to Inngest. Execution resumes in the same request: the step's
    // handle() fires wrapStep a second time (to apply middleware to the
    // result), then the function runs to completion without a second HTTP
    // request.
    "wrapRequest: before",
    "transformFunctionInput",
    "onMemoizationEnd",
    "onRunStart",
    "wrapFunctionHandler: before",
    "fn: top",
    "transformStepInput(fresh)",
    "wrapStep(fresh): before",
    "onStepStart",
    "step: inside",
    "wrapStep(fresh): after",
    "onStepComplete",
    // Second wrapStep: handle() fires the middleware chain to resolve the
    // step promise. Marked memoized so middleware can deserialize/decrypt.
    "wrapStep(memo): before",
    "wrapStep(memo): after",
    "fn: bottom",
    "wrapFunctionHandler: after",
    "onRunComplete",
    "wrapRequest: after",
  ]);
});
