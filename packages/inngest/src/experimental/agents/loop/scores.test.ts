/**
 * @module
 * Tests for the score helpers: what rides on a step, what is refused, and that
 * a server that cannot take a score never fails the run.
 */
import { describe, expect, test, vi } from "vitest";
import {
  type Inngest,
  Inngest as InngestClient,
  internalLoggerSymbol,
} from "../../../components/Inngest.ts";
import { step } from "../../../components/InngestStepTools.ts";
import { runFnWithStack, testClientId } from "../../../test/helpers.ts";
import { createAgentScore, scoreThisStep } from "./scores.ts";

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
      scoreThisStep("agent.tool_error", true);
    });

    expect(scores).toEqual({
      "agent.model_ms": { scope: "step", value: 12 },
      "agent.tool_error": { scope: "step", value: true },
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

/**
 * Runs a function whose handler calls `score` outside any step, with a client
 * whose `score` is `write`. Returns what each run reported.
 */
const handlerScores = async (options: {
  write: () => Promise<void>;
  call?: (score: ReturnType<typeof createAgentScore>["score"]) => Promise<void>;
  stepState?: Parameters<typeof runFnWithStack>[1];
}) => {
  const warn = vi.fn();
  const client = new InngestClient({ id: testClientId });
  const score = vi.fn(options.write);

  Object.defineProperty(client, "score", { value: score });
  Object.defineProperty(client, internalLoggerSymbol, { value: { warn } });

  const fn = client.createFunction(
    { id: "scores", triggers: [{ event: "scores/run" }] },
    async () => {
      const scorer = createAgentScore(client);

      await (options.call ?? ((s) => s("support.noted", 7)))(scorer.score);
      await scorer.flush();

      return "done";
    },
  );

  return {
    score,
    warn,
    ran: await runFnWithStack(fn, options.stepState ?? {}),
  };
};

describe("score", () => {
  test("inside a step it rides on the step and calls no API", async () => {
    const { client, score } = failingClient();
    const scores = await stepScores(async () => {
      await createAgentScore(client).score("support.noted", 7);
    });

    expect(scores).toEqual({ "support.noted": { scope: "step", value: 7 } });
    expect(score).not.toHaveBeenCalled();
  });

  test("outside a step it is one memoized step named from the score", async () => {
    const first = await handlerScores({ write: async () => {} });

    if (first.ran.type !== "step-ran") {
      throw new Error(`expected a step, got ${first.ran.type}`);
    }

    expect(first.ran.step.displayName).toBe("score:support.noted");
    expect(first.score).toHaveBeenCalledTimes(1);
    expect(first.score).toHaveBeenCalledWith({
      name: "support.noted",
      value: 7,
    });

    // The replay finds the step's answer, so nothing is written again.
    const replay = await handlerScores({
      write: async () => {},
      stepState: {
        [first.ran.step.id]: { id: first.ran.step.id, data: null },
      },
    });

    expect(replay.ran.type).toBe("function-resolved");
    expect(replay.score).not.toHaveBeenCalled();
  });

  test("an un-awaited score is still written before the handler ends", async () => {
    const { score } = await handlerScores({
      write: async () => {},
      call: async (call) => {
        void call("support.late", 1);
      },
    });

    expect(score).toHaveBeenCalledWith({ name: "support.late", value: 1 });
  });

  test("refuses a bad name or value, and a name that starts with agent.", async () => {
    const { client, score } = failingClient();
    const { score: call } = createAgentScore(client);

    await expect(call("", 1)).rejects.toThrow("name");
    await expect(call("it's", 1)).rejects.toThrow("single quotes");
    await expect(call("x", Number.NaN)).rejects.toThrow("finite");
    await expect(call("agent.model_ms", 1)).rejects.toThrow(
      "kept for the scores the framework writes",
    );
    expect(score).not.toHaveBeenCalled();
  });

  test("a refused score logs a warning and the run goes on", async () => {
    const { ran, warn, score } = await handlerScores({
      write: async () => {
        throw new Error("Failed to update metadata: Invalid metadata");
      },
    });

    // The step still completes, so the failure is not retried.
    expect(ran.type).toBe("step-ran");
    expect(score).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toEqual({
      error: "Failed to update metadata: Invalid metadata",
    });
  });
});
