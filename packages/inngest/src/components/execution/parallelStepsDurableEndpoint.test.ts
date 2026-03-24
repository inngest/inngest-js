import { fromPartial } from "@total-typescript/shoehorn";
import { describe, expect, test } from "vitest";
import { createClient, runFnWithStack } from "../../test/helpers.ts";
import { defaultCheckpointingOptions, StepMode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import { _internals } from "./engine.ts";

/**
 * Reproduces the parallel step deadlock in durable endpoints.
 * See PARALLEL_STEPS_BUG.md for full analysis.
 *
 * IMPORTANT: The baseline test must run before the deadlock tests.
 * Timed-out executions leave dangling microtask loops that
 * contaminate subsequent tests in the same process.
 */
describe("Parallel steps in durable endpoints (runToCompletion)", () => {
  const hashId = _internals.hashId;
  const client = createClient({ id: "test" });

  // Fresh copies per test — resumeStepWithResult mutates stepState
  // by writing executed step results back into it.
  function freshStepState() {
    return {
      [hashId("setup")]: { id: hashId("setup"), data: "setup-result" },
    };
  }
  const stepCompletionOrder = [hashId("setup")];

  function createFn() {
    return new InngestFunction(
      client,
      { id: "test-parallel", triggers: [{ event: "test/event" }] },
      async ({ step }) => {
        await step.run("setup", () => "setup-result");

        const [a, b] = await Promise.all([
          step.run("parallel-a", () => "result-a"),
          step.run("parallel-b", () => "result-b"),
        ]);

        return `done: ${a}, ${b}`;
      },
    );
  }

  // Mirrors `runFnWithStack` but adds runToCompletion and stepMode control,
  // plus checkpointingConfig for AsyncCheckpointing (as the real IS provides).
  async function runDurableExecution(opts: {
    stepMode: StepMode;
    requestedRunStep?: string;
  }) {
    const fn = createFn();
    const execution = fn["createExecution"]({
      partialOptions: {
        client: fn["client"],
        data: fromPartial({ event: { name: "test/event", data: {} } }),
        runId: "run",
        stepState: freshStepState(),
        stepCompletionOrder,
        reqArgs: [],
        headers: {},
        stepMode: opts.stepMode,
        requestedRunStep: opts.requestedRunStep,
        runToCompletion: true,
        queueItemId: "fake-queue-item-id",
        checkpointingConfig:
          opts.stepMode === StepMode.AsyncCheckpointing
            ? defaultCheckpointingOptions
            : undefined,
      },
    });

    const { ctx: _ctx, ops: _ops, ...rest } = await execution.start();
    return rest;
  }

  // Runs first to verify the normal (non-durable) path isn't broken.
  // Contrasts with the deadlock tests below: same function, different mode.
  test("non-durable async mode returns steps-found for parallel steps", async () => {
    const fn = createFn();
    const result = await runFnWithStack(fn, freshStepState(), {
      disableImmediateExecution: true,
      stackOrder: stepCompletionOrder,
    });
    expect(result.type).toBe("steps-found");
  });

  // Bug 1: IS sends requestedRunStep targeting one parallel step.
  // Engine executes that step but Promise.all still waits for the other
  // (discovered but never executed). Core loop deadlocks.
  //
  // stepMode=Async because shouldAsyncCheckpoint() returns undefined
  // when requestedRunStep is set.
  describe("Bug 1: Async handler deadlock (requestedRunStep set)", () => {
    test.each([
      { stepName: "parallel-a", label: "first" },
      { stepName: "parallel-b", label: "second" },
    ])(
      "completes when requestedRunStep targets the $label parallel step",
      { timeout: 10_000 },
      async ({ stepName }) => {
        const result = await runDurableExecution({
          stepMode: StepMode.Async,
          requestedRunStep: hashId(stepName),
        });

        expect(result).toMatchObject({
          type: "function-resolved",
          data: "done: result-a, result-b",
        });
      },
    );
  });

  // Bug 2: IS sends continuation (no requestedRunStep).
  // getEarlyExecRunStep bails (unfulfilledSteps.length !== 1),
  // falls through to maybeReturnNewSteps → 206. IS re-sends
  // requests A & B which hit Bug 1. Infinite loop.
  describe("Bug 2: AsyncCheckpointing returns steps-found instead of executing", () => {
    test(
      "executes both parallel steps instead of returning them",
      { timeout: 10_000 },
      async () => {
        const result = await runDurableExecution({
          stepMode: StepMode.AsyncCheckpointing,
        });

        expect(result).toMatchObject({
          type: "function-resolved",
          data: "done: result-a, result-b",
        });
      },
    );
  });
});
