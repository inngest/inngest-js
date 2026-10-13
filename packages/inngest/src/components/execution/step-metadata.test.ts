import { describe, expect, test, vi } from "vitest";
import { createClient, runFnWithStack } from "../../test/helpers.ts";
import { StepOpCode, type StepOptions } from "../../types.ts";
import { referenceFunction } from "../InngestFunctionReference.ts";
import { _internals } from "./engine.ts";

const kind = "userland.test";

const client = createClient({ id: "step-metadata-test" });

const fnOptions = {
  id: "step-metadata",
  triggers: [{ event: "foo" }],
};

const createStepFn = (
  metadata: NonNullable<StepOptions["metadata"]>,
  fn: () => unknown = () => "ok",
) => {
  return client.createFunction(fnOptions, async ({ step }) => {
    await step.run({ id: "a", metadata }, fn);
  });
};

describe("StepOptions.metadata", () => {
  test.each([
    {
      name: "a static record lands on the step op",
      values: { intent: "build" },
      expected: { intent: "build" },
    },
    {
      name: "a function receives the result of the step",
      values: (outcome: { data?: unknown }) => {
        return { outcome: outcome.data };
      },
      expected: { outcome: "ok" },
    },
  ])("$name", async ({ values, expected }) => {
    const handler = createStepFn({ kind, values });

    const result = await runFnWithStack(handler, {});

    expect(result).toMatchObject({
      type: "step-ran",
      step: {
        data: "ok",
        metadata: [{ kind, scope: "step", op: "merge", values: expected }],
      },
    });
  });

  test("a function receives the error of a failed step", async () => {
    const handler = createStepFn(
      {
        kind,
        values: (outcome) => {
          return { failed: String(outcome.error), data: outcome.data };
        },
      },
      () => {
        throw new Error("boom");
      },
    );

    const result = await runFnWithStack(handler, {});

    expect(result).toMatchObject({
      type: "step-ran",
      step: {
        op: StepOpCode.StepError,
        metadata: [{ kind, values: { failed: "Error: boom" } }],
      },
    });
  });

  test("a throwing function doesn't change the step's outcome", async () => {
    const handler = createStepFn({
      kind,
      values: () => {
        throw new Error("bad metadata");
      },
    });

    const result = await runFnWithStack(handler, {});

    expect(result).toMatchObject({ type: "step-ran", step: { data: "ok" } });
    expect(result).not.toHaveProperty("step.metadata");
  });

  test("a function isn't called when the step is memoized", async () => {
    const values = vi.fn(() => {
      return {};
    });
    const handler = createStepFn({ kind, values });

    const result = await runFnWithStack(handler, {
      [_internals.hashId("a")]: { id: _internals.hashId("a"), data: "ok" },
    });

    expect(result).toMatchObject({ type: "function-resolved" });
    expect(values).not.toHaveBeenCalled();
  });

  test("a static record lands on a planned step.invoke", async () => {
    const handler = client.createFunction(fnOptions, async ({ step }) => {
      await step.invoke(
        { id: "inv", metadata: { kind, values: { intent: "from" } } },
        {
          function: referenceFunction({ functionId: "other" }),
          data: {},
        },
      );
    });

    const result = await runFnWithStack(handler, {});

    expect(result).toMatchObject({
      type: "steps-found",
      steps: [
        {
          op: StepOpCode.InvokeFunction,
          metadata: [{ kind, scope: "step", values: { intent: "from" } }],
        },
      ],
    });
  });

  test("metadata adds no steps and keeps step IDs", async () => {
    const withMetadata = createStepFn({ kind, values: {} });
    const without = client.createFunction(fnOptions, async ({ step }) => {
      await step.run("a", () => "ok");
    });

    const a = await runFnWithStack(withMetadata, {});
    const b = await runFnWithStack(without, {});

    expect(a).toMatchObject({
      type: "step-ran",
      step: { id: (b as { step: { id: string } }).step.id },
    });
  });
});
