/**
 * @module
 * Tests for the score helpers: what rides on a step, what is refused, and that
 * a server that cannot take a score never fails the run.
 */
import { describe, expect, test, vi } from "vitest";
import { runFnWithStack, testClientId } from "../../test/helpers.ts";
import {
  type Inngest,
  Inngest as InngestClient,
  internalLoggerSymbol,
} from "../Inngest.ts";
import { step } from "../InngestStepTools.ts";
import { createAgentScores, scoreThisStep } from "./scores.ts";

/**
 * Runs a function whose body is `body` until its one step has run, and
 * returns the score metadata that step carried, by name.
 */
const stepScores = async (body: () => Promise<unknown>) => {
  const client = new InngestClient({ id: testClientId });
  const fn = client.createFunction(
    { id: "scores", triggers: [{ event: "scores/run" }] },
    async () => {
      await step.run("work", body);
    },
  );
  const ran = await runFnWithStack(fn, {});

  if (ran.type !== "step-ran") {
    throw new Error(`expected a step to run, got ${ran.type}`);
  }

  return Object.fromEntries(
    (
      (ran.step.metadata ?? []) as {
        kind: string;
        scope: string;
        values: unknown;
      }[]
    )
      .filter((update) => {
        return update.kind.startsWith("inngest.score.");
      })
      .map((update) => {
        return [
          update.kind.slice("inngest.score.".length),
          { scope: update.scope, ...(update.values as object) },
        ];
      }),
  );
};

const failingClient = () => {
  const warn = vi.fn();
  const score = vi.fn(async () => {
    throw new Error("Failed to update metadata: Invalid metadata");
  });

  return {
    warn,
    score,
    client: {
      score,
      [internalLoggerSymbol]: { warn },
    } as unknown as Inngest.Any,
  };
};

describe("scoreThisStep", () => {
  test("does nothing outside a step", () => {
    expect(scoreThisStep("agent.model_ms", 5)).toBe(false);
  });

  test("rides on the step that is running, at step scope", async () => {
    const scores = await stepScores(async () => {
      scoreThisStep("agent.model_ms", 12);
      scoreThisStep("agent.stopped", true);
    });

    expect(scores).toEqual({
      "agent.model_ms": { scope: "step", value: 12 },
      "agent.stopped": { scope: "step", value: true },
    });
  });

  test("the last write of a name wins", async () => {
    const scores = await stepScores(async () => {
      scoreThisStep("agent.tool_error", 1);
      scoreThisStep("agent.tool_error", 0);
    });

    expect(scores).toEqual({
      "agent.tool_error": { scope: "step", value: 0 },
    });
  });

  test("ignores a number that is not finite", async () => {
    const scores = await stepScores(async () => {
      scoreThisStep("agent.model_ms", Number.NaN);
      scoreThisStep("agent.tool_ms", Number.POSITIVE_INFINITY);
    });

    expect(scores).toEqual({});
  });
});

describe("scores.score", () => {
  test("inside a step it rides on the step and calls no API", async () => {
    const { client, score } = failingClient();
    const scores = await stepScores(async () => {
      await createAgentScores(client).score("support.noted", 7);
    });

    expect(scores).toEqual({ "support.noted": { scope: "step", value: 7 } });
    expect(score).not.toHaveBeenCalled();
  });

  test("outside a step it sets a run score through the client", async () => {
    const score = vi.fn(async () => {});
    const client = { score } as unknown as Inngest.Any;

    await createAgentScores(client).score("support.noted", true);

    expect(score).toHaveBeenCalledWith({ name: "support.noted", value: true });
  });

  test("refuses a bad name or value, and a name that starts with agent.", async () => {
    const { client, score } = failingClient();
    const scores = createAgentScores(client);

    await expect(scores.score("", 1)).rejects.toThrow("name");
    await expect(scores.score("it's", 1)).rejects.toThrow("single quotes");
    await expect(scores.score("x", Number.NaN)).rejects.toThrow("finite");
    await expect(scores.score("agent.model_ms", 1)).rejects.toThrow(
      "kept for the scores the framework writes",
    );
    expect(score).not.toHaveBeenCalled();
  });

  test("a server that refuses the score does not fail the call, and is logged once", async () => {
    const { client, warn, score } = failingClient();
    const scores = createAgentScores(client);

    await expect(scores.score("support.a", 1)).resolves.toBeUndefined();
    await expect(scores.score("support.b", 2)).resolves.toBeUndefined();

    expect(score).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      error: "Failed to update metadata: Invalid metadata",
    });
  });
});
