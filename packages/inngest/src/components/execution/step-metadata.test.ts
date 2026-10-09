import { describe, expect, test } from "vitest";
import { createClient, runFnWithStack } from "../../test/helpers.ts";
import { StepOpCode } from "../../types.ts";
import { referenceFunction } from "../InngestFunctionReference.ts";

const kind = "userland.test";

const client = createClient({ id: "step-metadata-test" });

const fnOptions = {
  id: "step-metadata",
  triggers: [{ event: "foo" }],
};

describe("StepOptions.metadata", () => {
  test("a static record lands on the step op", async () => {
    const fn = client.createFunction(fnOptions, async ({ step }) => {
      await step.run(
        { id: "a", metadata: { kind, values: { intent: "build" } } },
        () => "ok",
      );
    });

    const result = await runFnWithStack(fn, {});

    expect(result).toMatchObject({
      type: "step-ran",
      step: {
        data: "ok",
        metadata: [
          { kind, scope: "step", op: "merge", values: { intent: "build" } },
        ],
      },
    });
  });

  test("a function receives the result of the step", async () => {
    const fn = client.createFunction(fnOptions, async ({ step }) => {
      await step.run(
        {
          id: "a",
          metadata: {
            kind,
            values: (outcome) => {
              return { outcome: outcome.data };
            },
          },
        },
        () => "ok",
      );
    });

    const result = await runFnWithStack(fn, {});

    expect(result).toMatchObject({
      type: "step-ran",
      step: { metadata: [{ kind, values: { outcome: "ok" } }] },
    });
  });

  test("a function receives the error of a failed step", async () => {
    const fn = client.createFunction(fnOptions, async ({ step }) => {
      await step.run(
        {
          id: "a",
          metadata: {
            kind,
            values: (outcome) => {
              return { failed: String(outcome.error), data: outcome.data };
            },
          },
        },
        () => {
          throw new Error("boom");
        },
      );
    });

    const result = await runFnWithStack(fn, {});

    expect(result).toMatchObject({
      type: "step-ran",
      step: {
        op: StepOpCode.StepError,
        metadata: [{ kind, values: { failed: "Error: boom" } }],
      },
    });
  });

  test("a throwing function doesn't change the step's outcome", async () => {
    const fn = client.createFunction(fnOptions, async ({ step }) => {
      await step.run(
        {
          id: "a",
          metadata: {
            kind,
            values: () => {
              throw new Error("bad metadata");
            },
          },
        },
        () => "ok",
      );
    });

    const result = await runFnWithStack(fn, {});

    expect(result).toMatchObject({ type: "step-ran", step: { data: "ok" } });
    expect(result).not.toHaveProperty("step.metadata");
  });

  test("a static record lands on a planned step.invoke", async () => {
    const fn = client.createFunction(fnOptions, async ({ step }) => {
      await step.invoke(
        { id: "inv", metadata: { kind, values: { intent: "from" } } },
        {
          function: referenceFunction({ functionId: "other" }),
          data: {},
        },
      );
    });

    const result = await runFnWithStack(fn, {});

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
    const withMetadata = client.createFunction(fnOptions, async ({ step }) => {
      await step.run({ id: "a", metadata: { kind, values: {} } }, () => 1);
    });
    const without = client.createFunction(fnOptions, async ({ step }) => {
      await step.run("a", () => 1);
    });

    const a = await runFnWithStack(withMetadata, {});
    const b = await runFnWithStack(without, {});

    expect(a).toMatchObject({
      type: "step-ran",
      step: { id: (b as { step: { id: string } }).step.id },
    });
  });
});
