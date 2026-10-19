/**
 * Tests of the cleanup on the way out: which runs are cancelled, and that the
 * wait for cleanup is bounded.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import type { RunInfo } from "./devServer.ts";
import { cancelStrays } from "./strays.ts";

const run = (id: string, functionId: string, eventId: string): RunInfo => {
  return { id, functionId, eventIds: [eventId] };
};

const strays = (runs: () => RunInfo[], eventIds = ["e1"], graceMs = 100) => {
  const cancelled: string[] = [];

  return {
    cancelled,
    result: cancelStrays({
      eventIds,
      graceMs,
      pollMs: 5,
      listRuns: async () => {
        return runs();
      },
      cancel: async (id) => {
        cancelled.push(id);
      },
    }),
  };
};

describe("cancelStrays", () => {
  test("cancels unfinished runs of the session's events only", async () => {
    const { cancelled, result } = strays(() => {
      return [
        run("mine", "pr", "e1"),
        run("other", "pr", "e2"),
        { ...run("done", "pr", "e1"), terminal: "passed" },
        run("cleanup", "pr/cleanup", "e1"),
      ];
    });

    expect(await result).toEqual(["mine"]);
    expect(cancelled).toEqual(["mine"]);
  });

  test("cancels nothing and returns at once when nothing is running", async () => {
    const started = Date.now();
    const { result } = strays(() => {
      return [];
    });

    expect(await result).toEqual([]);
    expect(Date.now() - started).toBeLessThan(50);
  });

  test("waits for cleanup runs, but only for the grace period", async () => {
    const started = Date.now();
    const { result } = strays(() => {
      return [run("mine", "pr", "e1"), run("c", "pr/cleanup", "e9")];
    });

    await result;

    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
  });

  test("stops waiting once the cancelled run and cleanup have ended", async () => {
    let polls = 0;
    const started = Date.now();
    const { result } = strays(
      () => {
        polls += 1;

        return polls === 1 ? [run("mine", "pr", "e1")] : [];
      },
      ["e1"],
      5000,
    );

    await result;

    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("never throws when the Dev Server can't be asked", async () => {
    const result = await cancelStrays({
      eventIds: ["e1"],
      graceMs: 10,
      pollMs: 1,
      listRuns: async () => {
        throw new Error("down");
      },
      cancel: async () => {},
    });

    expect(result).toEqual([]);
  });
});
