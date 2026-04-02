import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createClient } from "../../test/helpers.ts";
import { type IncomingOp, StepMode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import { _internals } from "./engine.ts";

const hashId = _internals.hashId;

const runMissingStepExecution = async ({
  stepIds,
  replayedStepIds,
}: {
  stepIds: string[];
  replayedStepIds?: string[];
}) => {
  const client = createClient({ id: "missing-step-test" });

  const fn = new InngestFunction(
    client,
    {
      id: "Missing step test",
      triggers: [{ event: "foo" }],
    },
    async ({ step }) => {
      await Promise.all(
        stepIds.map((stepId) => step.run(stepId, () => stepId)),
      );
    },
  );

  const stepState = (replayedStepIds ?? []).reduce<Record<string, IncomingOp>>(
    (acc, stepId) => {
      const hashedId = hashId(stepId);
      acc[hashedId] = { id: hashedId, data: `${stepId}-replayed` };
      return acc;
    },
    {},
  );

  const execution = fn["createExecution"]({
    partialOptions: {
      client: fn["client"],
      data: fromPartial({
        event: { name: "foo", data: {} },
      }),
      runId: "run",
      stepState,
      stepCompletionOrder: Object.keys(stepState),
      isFailureHandler: false,
      requestedRunStep: hashId("missing-step"),
      reqArgs: [],
      headers: {},
      stepMode: StepMode.Async,
      internalFnId: "fake-fn-id",
      queueItemId: "fake-queue-item-id",
    },
  });
  // requestedRunStep timers can reset while steps are discovered; shorten this
  // for deterministic, fast fake-timer tests.
  (execution as { timeoutDuration?: number }).timeoutDuration = 50;

  const executionPromise = execution.start();
  let settled = false;
  void executionPromise.finally(() => {
    settled = true;
  });

  for (let i = 0; i < 200 && !settled; i++) {
    await vi.advanceTimersByTimeAsync(50);
  }

  return await executionPromise;
};

describe("step-not-found diagnostics", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("returns only unreplayed steps", async () => {
    const result = await runMissingStepExecution({
      stepIds: ["A", "B"],
      replayedStepIds: ["A"],
    });

    expect(result.type).toBe("step-not-found");
    if (result.type !== "step-not-found") {
      return;
    }

    const replayedStepHash = hashId("A");
    expect(result.totalFoundSteps).toBe(1);
    expect(result.foundSteps).toHaveLength(1);
    expect(result.foundSteps[0]).toMatchObject({
      id: hashId("B"),
      name: "B",
      displayName: "B",
    });
    expect(result.foundSteps.map((step) => step.id)).not.toContain(
      replayedStepHash,
    );
  }, 15_000);

  test("caps found steps at 25", async () => {
    const stepIds = Array.from({ length: 30 }, (_, i) => `step-${i}`);

    const result = await runMissingStepExecution({
      stepIds,
      replayedStepIds: ["step-0"],
    });

    expect(result.type).toBe("step-not-found");
    if (result.type !== "step-not-found") {
      return;
    }

    const foundStepIds = result.foundSteps.map((step) => step.id);
    expect(result.totalFoundSteps).toBe(29);
    expect(result.foundSteps).toHaveLength(25);
    expect(foundStepIds).toEqual(
      [...foundStepIds].sort((a, b) => a.localeCompare(b)),
    );
    expect(foundStepIds).not.toContain(hashId("step-0"));
  }, 15_000);
});
