/**
 * @module
 * Tests for the scores `report()` writes on its post steps, with the score
 * writer replaced so each call can be read.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { createReporter, defineChannel } from "./channels.ts";

const scored = vi.hoisted(() => {
  return [] as [string, number][];
});

vi.mock("./scores.ts", () => {
  return {
    scoreThisStep: (name: string, value: number) => {
      scored.push([name, value]);

      return true;
    },
  };
});

const channel = defineChannel({ post: async () => {} });

/**
 * Runs the post step the way the executor does: live, or replayed from `saved`
 * by step ID, in which case the post does not run again.
 */
const stepper = (saved: Record<string, unknown> = {}) => {
  const ran: string[] = [];

  return {
    ran,
    runStep: async (id: string, fn: () => Promise<number | undefined>) => {
      if (id in saved) {
        return saved[id];
      }

      ran.push(id);

      return fn();
    },
  };
};

describe("report scores", () => {
  beforeEach(() => {
    scored.length = 0;
  });

  test("scores the first post from the trigger and the next from the first", async () => {
    const { runStep, ran } = stepper();
    const report = createReporter({ main: channel }, undefined, runStep, {
      since: Date.now() - 100,
    });

    await report("one");
    await report("two");

    expect(ran).toEqual(["report:1:0:main", "report:2:0:main"]);
    expect(scored.map(([name]) => name)).toEqual([
      "agent.first_output_ms",
      "agent.output_gap_ms",
    ]);
    expect(scored[0]?.[1]).toBeGreaterThanOrEqual(100);
  });

  test("a second destination of one report is measured like the first", async () => {
    const { runStep } = stepper();
    const report = createReporter(
      { a: channel, b: channel },
      ["a", "b"],
      runStep,
      { since: Date.now() - 100 },
    );

    await report("one");

    expect(scored.map(([name]) => name)).toEqual([
      "agent.first_output_ms",
      "agent.first_output_ms",
    ]);
  });

  test("a post saved by a run without scores is not scored again, and does not make the next post a first", async () => {
    // The first post was saved before posts returned their time: its result
    // is nothing. Replaying it must not score, and the post after it must not
    // be scored as the first, or from a time it never had.
    const { runStep, ran } = stepper({ "report:1:0:main": undefined });
    const report = createReporter({ main: channel }, undefined, runStep, {
      since: Date.now() - 100,
    });

    await report("one");
    await report("two");

    expect(ran).toEqual(["report:2:0:main"]);
    expect(scored).toEqual([]);
  });

  test("a post saved with its time scores the next post from it", async () => {
    const saved = { "report:1:0:main": Date.now() - 40 };
    const { runStep } = stepper(saved);
    const report = createReporter({ main: channel }, undefined, runStep, {
      since: Date.now() - 1000,
    });

    await report("one");
    await report("two");

    expect(scored.map(([name]) => name)).toEqual(["agent.output_gap_ms"]);
    expect(scored[0]?.[1]).toBeGreaterThanOrEqual(40);
  });

  test("without scores the post step returns nothing and scores nothing", async () => {
    const results: unknown[] = [];
    const report = createReporter(
      { main: channel },
      undefined,
      async (_id, fn) => {
        results.push(await fn());

        return undefined;
      },
    );

    await report("one");

    expect(results).toEqual([undefined]);
    expect(scored).toEqual([]);
  });

  test("a trigger without a time scores no first post but scores the gaps", async () => {
    const { runStep } = stepper();
    const report = createReporter({ main: channel }, undefined, runStep, {});

    await report("one");
    await report("two");

    expect(scored.map(([name]) => name)).toEqual(["agent.output_gap_ms"]);
  });
});
