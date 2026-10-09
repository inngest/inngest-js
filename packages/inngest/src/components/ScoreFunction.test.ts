import { describe, expect, test, vi } from "vitest";
import { Inngest, internalLoggerSymbol } from "./Inngest.ts";
import { createScorer } from "./ScoreFunction.ts";

type Handler = (ctx: unknown) => Promise<unknown>;

const experiment = { experimentName: "exp", variant: "control" };

// Runs the scorer's wrapped handler directly w/ a stub ctx, so we can assert
// what reaches client.score w/o an engine.
const runScorer = async (
  result: Record<string, unknown>,
  parent: Record<string, unknown>,
) => {
  const client = new Inngest({ id: "test", isDev: true });
  const score = Object.assign(vi.fn(), { experiment: vi.fn() });
  // client.score is a getter returning a fresh object, so stub the getter.
  Object.defineProperty(client, "score", { get: () => score });
  const warn = vi
    .spyOn(client[internalLoggerSymbol], "warn")
    .mockImplementation(() => {});

  const scorer = createScorer(client, { id: "s" }, async () => result as never);
  const fn = (scorer as unknown as { fn: Handler }).fn;
  await fn({
    parents: [parent],
    step: { run: async (_id: string, cb: () => unknown) => cb() },
  });

  return { score, warn };
};

describe("createScorer", () => {
  test("drops stepId for experiment parents", async () => {
    const { score, warn } = await runScorer(
      { name: "rizz", value: 1, stepId: "variant-step" },
      { fnSlug: "parent", runId: "run-1", experiment },
    );

    expect(score.experiment).toHaveBeenCalledWith({
      experiment,
      runId: "run-1",
      name: "rizz",
      value: 1,
    });
    expect(score).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('ignoring stepId "variant-step"');
  });

  test("doesn't warn for experiment parents w/o stepId", async () => {
    const { score, warn } = await runScorer(
      { name: "rizz", value: 1 },
      { fnSlug: "parent", runId: "run-1", experiment },
    );

    expect(score.experiment).toHaveBeenCalledWith({
      experiment,
      runId: "run-1",
      name: "rizz",
      value: 1,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  test("keeps stepId for non-experiment parents", async () => {
    const { score, warn } = await runScorer(
      { name: "rizz", value: 1, stepId: "some-step" },
      { fnSlug: "parent", runId: "run-1" },
    );

    expect(score).toHaveBeenCalledWith({
      runId: "run-1",
      name: "rizz",
      value: 1,
      stepId: "some-step",
    });
    expect(score.experiment).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
