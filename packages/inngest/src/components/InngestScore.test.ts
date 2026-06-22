import { describe, expect, test, vi } from "vitest";

import type { KnownKeys } from "../helpers/types.ts";
import { Inngest } from "./Inngest.ts";
import {
  type ScoreOptions,
  scoreMiddleware,
  type scoreSymbol,
  validateStepScoreOptions,
} from "./InngestScore.ts";
import type { ExperimentalStepTools } from "./InngestStepTools.ts";

type Not<T extends boolean> = T extends true ? false : true;

type HasProperty<
  T,
  I extends string | number | symbol,
  E extends string | number | symbol = "",
> = T extends {
  [K in I]: unknown;
}
  ? Not<HasProperty<T, E>>
  : false;

describe("client.score validation", () => {
  test("rejects invalid input before sending metadata", async () => {
    const client = new Inngest({ id: "app" });

    await expect(
      client.score(undefined as unknown as ScoreOptions),
    ).rejects.toThrow("score options must be an object");

    await expect(
      client.score({
        runId: "",
        stepId: "step",
        name: "accuracy",
        value: 1,
      }),
    ).rejects.toThrow("runId must be a non-empty string");

    await expect(
      client.score({
        runId: "run",
        stepId: "",
        name: "accuracy",
        value: 1,
      }),
    ).rejects.toThrow("stepId must be a non-empty string");

    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        value: 1,
      } as unknown as ScoreOptions),
    ).rejects.toThrow("score name must be a non-empty string");

    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        name: "",
        value: 1,
      }),
    ).rejects.toThrow("score name must be a non-empty string");

    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        name: "   ",
        value: 1,
      }),
    ).rejects.toThrow("score name must be a non-empty string");

    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        name: "x".repeat(129),
        value: 1,
      }),
    ).rejects.toThrow("score name must be 128 bytes or fewer");

    // 60 × "é" = 130 UTF-8 bytes, under the 128-char limit but over the byte cap.
    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        name: "é".repeat(65),
        value: 1,
      }),
    ).rejects.toThrow("score name must be 128 bytes or fewer");

    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        name: "foo\nbar",
        value: 1,
      }),
    ).rejects.toThrow(
      "score name must not contain control characters or single quotes",
    );

    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        name: "it's-broken",
        value: 1,
      }),
    ).rejects.toThrow(
      "score name must not contain control characters or single quotes",
    );

    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        name: "accuracy",
        value: Number.NaN,
      }),
    ).rejects.toThrow("finite number or boolean");
  });

  test("requires an explicit run outside execution context", async () => {
    const client = new Inngest({ id: "app" });

    await expect(
      client.score({
        name: "accuracy",
        value: 1,
      } satisfies ScoreOptions),
    ).rejects.toThrow("No run context available");
  });

  test("emits inngest.score kind with <name>.value-keyed payload", async () => {
    const client = new Inngest({ id: "app" });
    const spy = vi
      .fn<
        (args: {
          target: { run_id: string };
          metadata: Array<{
            kind: string;
            op: string;
            values: Record<string, unknown>;
          }>;
        }) => Promise<void>
      >()
      .mockResolvedValue();
    (client as unknown as { updateMetadata: typeof spy }).updateMetadata = spy;

    await client.score({
      runId: "run-abc",
      name: "click-through rate (variant A)!",
      value: 0.23,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]?.metadata).toEqual([
      {
        kind: "inngest.score",
        op: "merge",
        values: { "click-through rate (variant A)!": { value: 0.23 } },
      },
    ]);
  });

  test("accepts boolean values in the named-score shape", async () => {
    const client = new Inngest({ id: "app" });
    const spy = vi
      .fn<
        (args: {
          metadata: Array<{
            kind: string;
            values: Record<string, unknown>;
          }>;
        }) => Promise<void>
      >()
      .mockResolvedValue();
    (client as unknown as { updateMetadata: typeof spy }).updateMetadata = spy;

    await client.score({ runId: "run-abc", name: "pass", value: true });

    expect(spy.mock.calls[0]?.[0]?.metadata).toEqual([
      {
        kind: "inngest.score",
        op: "merge",
        values: { pass: { value: true } },
      },
    ]);
  });
});

describe("step.score validation", () => {
  test("rejects invalid input", () => {
    expect(() =>
      validateStepScoreOptions({
        runId: "",
        name: "accuracy",
        value: 1,
      }),
    ).toThrow("runId must be a non-empty string");

    expect(() =>
      validateStepScoreOptions({
        stepId: "",
        name: "accuracy",
        value: 1,
      }),
    ).toThrow("stepId must be a non-empty string");

    expect(() =>
      validateStepScoreOptions({
        name: "",
        value: 1,
      }),
    ).toThrow("score name must be a non-empty string");

    expect(() =>
      validateStepScoreOptions({
        name: "   ",
        value: 1,
      }),
    ).toThrow("score name must be a non-empty string");

    expect(() =>
      validateStepScoreOptions({
        name: "x".repeat(129),
        value: 1,
      }),
    ).toThrow("score name must be 128 bytes or fewer");

    expect(() =>
      validateStepScoreOptions({
        name: "é".repeat(65),
        value: 1,
      }),
    ).toThrow("score name must be 128 bytes or fewer");

    expect(() =>
      validateStepScoreOptions({
        name: "foo\tbar",
        value: 1,
      }),
    ).toThrow(
      "score name must not contain control characters or single quotes",
    );

    expect(() =>
      validateStepScoreOptions({
        name: "it's-broken",
        value: 1,
      }),
    ).toThrow(
      "score name must not contain control characters or single quotes",
    );

    expect(() =>
      validateStepScoreOptions({
        name: "accuracy",
        value: Number.POSITIVE_INFINITY,
      }),
    ).toThrow("finite number or boolean");
  });

  test("accepts optional targets, arbitrary names, and boolean values", () => {
    expect(() =>
      validateStepScoreOptions({
        name: "accuracy",
        value: true,
      } satisfies ScoreOptions),
    ).not.toThrow();

    expect(() =>
      validateStepScoreOptions({
        name: "click-through rate (variant A)!",
        value: 0.23,
      } satisfies ScoreOptions),
    ).not.toThrow();
  });
});

describe("scoreMiddleware", () => {
  test("score is only present as a step tool if the middleware is used", () => {
    const inngestWithoutMiddleware = new Inngest({
      id: "test",
      eventKey: "test-key-123",
    });

    inngestWithoutMiddleware.createFunction(
      { id: "test", triggers: [{ event: "foo" }] },
      ({ step }) => {
        assertType<HasProperty<typeof step, "score">>(false);
      },
    );

    const inngestWithMiddleware = new Inngest({
      id: "test",
      eventKey: "test-key-123",
      middleware: [scoreMiddleware()],
    });

    inngestWithMiddleware.createFunction(
      { id: "test", triggers: [{ event: "foo" }] },
      ({ step }) => {
        assertType<HasProperty<typeof step, "score">>(true);
        assertType<ExperimentalStepTools[typeof scoreSymbol]>(step.score);
        assertType<KnownKeys<typeof step>>("score");
      },
    );
  });
});
