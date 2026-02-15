import { fromPartial } from "@total-typescript/shoehorn";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ExecutionVersion } from "../../helpers/consts.ts";
import { createClient } from "../../test/helpers.ts";
import { type IncomingOp, StepMode } from "../../types.ts";
import { InngestFunction } from "../InngestFunction.ts";
import { _internals as v1Internals } from "./v1.ts";
import { _internals as v2Internals } from "./v2.ts";

const hashByVersion: Record<
  ExecutionVersion.V1 | ExecutionVersion.V2,
  (id: string) => string
> = {
  [ExecutionVersion.V1]: v1Internals.hashId,
  [ExecutionVersion.V2]: v2Internals.hashId,
};

const runMissingStepExecution = async ({
  version,
  stepIds,
  replayedStepIds,
}: {
  version: ExecutionVersion.V1 | ExecutionVersion.V2;
  stepIds: string[];
  replayedStepIds?: string[];
}) => {
  const client = createClient({ id: `missing-step-test-${version}` });
  const hashId = hashByVersion[version];

  const fn = new InngestFunction(
    client,
    {
      id: `Missing step test ${version}`,
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
    version,
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
  await vi.advanceTimersByTimeAsync(1_000);

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

  test.each([ExecutionVersion.V1, ExecutionVersion.V2] as const)(
    "returns only unreplayed steps for %s",
    async (version) => {
      const result = await runMissingStepExecution({
        version,
        stepIds: ["A", "B"],
        replayedStepIds: ["A"],
      });

      expect(result.type).toBe("step-not-found");
      if (result.type !== "step-not-found") {
        return;
      }

      const replayedStepHash = hashByVersion[version]("A");
      expect(result.totalFoundSteps).toBe(1);
      expect(result.foundSteps).toHaveLength(1);
      expect(result.foundSteps[0]).toMatchObject({
        id: hashByVersion[version]("B"),
        name: "B",
        displayName: "B",
      });
      expect(result.foundSteps.map((step) => step.id)).not.toContain(
        replayedStepHash,
      );
    },
  );

  test.each([ExecutionVersion.V1, ExecutionVersion.V2] as const)(
    "caps found steps at 25 for %s",
    async (version) => {
      const stepIds = Array.from({ length: 30 }, (_, i) => `step-${i}`);

      const result = await runMissingStepExecution({
        version,
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
      expect(foundStepIds).not.toContain(hashByVersion[version]("step-0"));
    },
  );
});
