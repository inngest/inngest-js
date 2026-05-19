import { describe, expect, test } from "vitest";

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
    ).rejects.toThrow("invalid score name");

    await expect(
      client.score({
        runId: "run",
        stepId: "step",
        name: "bad-name",
        value: 1,
      }),
    ).rejects.toThrow("invalid score name");

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
        name: "bad-name",
        value: 1,
      }),
    ).toThrow("invalid score name");

    expect(() =>
      validateStepScoreOptions({
        name: "accuracy",
        value: Number.POSITIVE_INFINITY,
      }),
    ).toThrow("finite number or boolean");
  });

  test("accepts optional targets and boolean values", () => {
    expect(() =>
      validateStepScoreOptions({
        name: "accuracy",
        value: true,
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
