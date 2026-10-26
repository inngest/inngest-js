/**
 * @module
 * Execution tests for `step.memo()`: it resolves in-process, is saved to
 * Inngest as a lazy op ahead of any other step, and returns the saved value on
 * replay.
 */

import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, test, vi } from "vitest";
import { Middleware } from "../../index.ts";
import { createClient } from "../../test/helpers.ts";
import { type Context, StepMode, StepOpCode } from "../../types.ts";
import type { GenericStepTools } from "../InngestStepTools.ts";
import { _internals } from "./engine.ts";
import type { ExecutionResults } from "./InngestExecution.ts";

const hashId = _internals.hashId;

type Handler = (ctx: Context.Any & { step: GenericStepTools }) => unknown;

const run = async ({
  handler,
  middleware = [],
  stepMode = StepMode.Async,
  stepState = {},
  stepCompletionOrder = [],
  checkpointStepsAsync = vi.fn().mockResolvedValue(undefined),
}: {
  handler: Handler;
  middleware?: Middleware.Class[];
  stepMode?: StepMode;
  stepState?: Record<string, { id: string; data: unknown }>;
  stepCompletionOrder?: string[];
  checkpointStepsAsync?: ReturnType<typeof vi.fn>;
}) => {
  const client = createClient({ id: "test", isDev: true, middleware });

  (client as unknown as { inngestApi: unknown }).inngestApi = {
    checkpointStepsAsync,
  };

  const fn = client.createFunction(
    { id: "test-fn", triggers: [{ event: "test/event" }] },
    handler as never,
  );

  const execution = fn["createExecution"]({
    partialOptions: {
      client,
      data: fromPartial({ event: { name: "test/event", data: {} } }),
      runId: "test-run-id",
      stepState,
      stepCompletionOrder,
      reqArgs: [],
      headers: {},
      stepMode,
      queueItemId: "queue-item-123",
      internalFnId: "internal-fn-456",
    },
  });

  const result = await execution.start();

  return { result, checkpointStepsAsync };
};

const stepsOf = (result: unknown) => {
  return (result as ExecutionResults["steps-found"]).steps;
};

describe("step.memo", () => {
  test("alone: resolves in-process and is saved as a StepRun op with data", async () => {
    const seen: unknown[] = [];

    const { result } = await run({
      handler: async ({ step }) => {
        seen.push(await step.memo("m", { a: 1 }));
        seen.push("after");
      },
    });

    expect(seen).toEqual([{ a: 1 }, "after"]);
    expect(result.type).toBe("steps-found");
    expect(stepsOf(result)).toHaveLength(1);
    expect(stepsOf(result)[0]).toMatchObject({
      id: hashId("m"),
      op: StepOpCode.StepRun,
      data: { a: 1 },
    });
  });

  test("in parallel with a run: the memo is saved alone and the run does not start", async () => {
    const stepFn = vi.fn();

    const { result } = await run({
      handler: async ({ step }) => {
        await Promise.all([
          step.memo("m", "value"),
          step.run("r", () => {
            stepFn();
            return "ran";
          }),
        ]);
      },
    });

    expect(stepFn).not.toHaveBeenCalled();
    expect(stepsOf(result)).toHaveLength(1);
    expect(stepsOf(result)[0]).toMatchObject({
      id: hashId("m"),
      op: StepOpCode.StepRun,
      data: "value",
    });
  });

  test("before a run: the memo is saved first, then the run proceeds as usual", async () => {
    const handler: Handler = async ({ step }) => {
      const value = await step.memo("m", "value");
      return step.run("r", () => `ran with ${value}`);
    };

    const first = await run({ handler });
    expect(stepsOf(first.result)).toHaveLength(1);
    expect(stepsOf(first.result)[0]?.id).toBe(hashId("m"));

    const second = await run({
      handler,
      stepState: { [hashId("m")]: { id: hashId("m"), data: "value" } },
      stepCompletionOrder: [hashId("m")],
    });
    expect(second.result.type).toBe("step-ran");
    expect((second.result as ExecutionResults["step-ran"]).step).toMatchObject({
      id: hashId("r"),
      op: StepOpCode.StepRun,
      data: "ran with value",
    });
  });

  test("checkpointing: the memo is checkpointed alone before the run", async () => {
    const { checkpointStepsAsync } = await run({
      stepMode: StepMode.AsyncCheckpointing,
      handler: async ({ step }) => {
        await Promise.all([step.memo("m", 1), step.run("r", () => 2)]);
      },
    });

    const calls = checkpointStepsAsync.mock.calls.map(([args]) => {
      return args.steps.map((s: { id: string }) => s.id);
    });
    expect(calls[0]).toEqual([hashId("m")]);
    expect(calls.flat()).toContain(hashId("r"));
  });

  test("replay returns the stored value, not the new one", async () => {
    const { result } = await run({
      handler: async ({ step }) => {
        return step.memo("m", "new");
      },
      stepState: { [hashId("m")]: { id: hashId("m"), data: "stored" } },
      stepCompletionOrder: [hashId("m")],
    });

    expect(result).toMatchObject({
      type: "function-resolved",
      data: "stored",
    });
  });

  test("the value is serialized the same as step.run", async () => {
    const input = {
      date: new Date("2020-01-01T00:00:00.000Z"),
      undef: undefined,
      nan: Number.NaN,
      nested: [1, () => 1],
    };

    const memoed: unknown[] = [];
    await run({
      handler: async ({ step }) => {
        memoed.push(await step.memo("m", input));
      },
    });

    const ran: unknown[] = [];
    await run({
      stepMode: StepMode.AsyncCheckpointing,
      handler: async ({ step }) => {
        ran.push(await step.run("r", () => input));
      },
    });

    expect(memoed).toEqual(ran);
    expect(memoed[0]).toEqual({
      date: "2020-01-01T00:00:00.000Z",
      nan: null,
      nested: [1, null],
    });
  });

  test("undefined is returned as null, as from step.run", async () => {
    const seen: unknown[] = [];
    const { result } = await run({
      handler: async ({ step }) => {
        seen.push(await step.memo("m", undefined));
      },
    });

    expect(seen).toEqual([null]);
    expect(stepsOf(result)[0]?.data).toBeNull();
  });

  test("middleware sees it as a step and can transform it", async () => {
    const calls: string[] = [];

    class Wrap extends Middleware.BaseMiddleware {
      readonly id = "wrap";

      override async wrapStepHandler({
        next,
        stepInfo,
      }: Middleware.WrapStepHandlerArgs) {
        calls.push(`handler:${stepInfo.options.id}:${stepInfo.stepType}`);
        return { wrapped: await next() };
      }

      override async wrapStep({ next, stepInfo }: Middleware.WrapStepArgs) {
        calls.push(`step:${stepInfo.options.id}`);
        const value = (await next()) as { wrapped: unknown };
        return value.wrapped;
      }

      override onStepComplete({ stepInfo }: Middleware.OnStepCompleteArgs) {
        calls.push(`complete:${stepInfo.options.id}`);
      }
    }

    const seen: unknown[] = [];
    const { result } = await run({
      middleware: [Wrap],
      handler: async ({ step }) => {
        seen.push(await step.memo("m", "v"));
      },
    });

    expect(seen).toEqual(["v"]);
    expect(calls).toEqual(
      expect.arrayContaining(["handler:m:run", "step:m", "complete:m"]),
    );
    expect(stepsOf(result)[0]?.data).toEqual({ wrapped: "v" });
  });

  test("repeated IDs follow the normal indexing rules", async () => {
    const seen: unknown[] = [];
    const { result } = await run({
      handler: async ({ step }) => {
        seen.push(await step.memo("m", 1));
        seen.push(await step.memo("m", 2));
      },
    });

    expect(seen).toEqual([1, 2]);
    expect(stepsOf(result).map((s) => s.id)).toEqual([
      hashId("m"),
      hashId("m:1"),
    ]);
  });

  test("a memo that finishes late does not ride with another step", async () => {
    class Slow extends Middleware.BaseMiddleware {
      readonly id = "slow";

      override async wrapStepHandler({
        next,
        stepInfo,
      }: Middleware.WrapStepHandlerArgs) {
        if (stepInfo.options.id === "m") {
          await new Promise((resolve) => setTimeout(resolve, 30));
        }

        return next();
      }
    }

    const { result } = await run({
      middleware: [Slow],
      handler: async ({ step }) => {
        await Promise.all([step.memo("m", 1), step.run("r", () => 2)]);
      },
    });

    const ids =
      result.type === "steps-found" ? stepsOf(result).map((s) => s.id) : [];
    expect(ids).not.toContain(hashId("m"));
  });

  test("a middleware that throws fails the await instead of hanging", async () => {
    class Throws extends Middleware.BaseMiddleware {
      readonly id = "throws";

      override async wrapStepHandler(): Promise<unknown> {
        throw new Error("boom");
      }
    }

    const { result } = await run({
      middleware: [Throws],
      handler: async ({ step }) => {
        await step.memo("m", 1);
      },
    });

    expect(result.type).toBe("function-rejected");
  });
});
