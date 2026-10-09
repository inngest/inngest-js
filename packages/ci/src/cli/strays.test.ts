/**
 * Tests for cancelling the runs a session started but didn't watch.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import type { ActiveRun } from "./devServerApi.ts";
import { cancelStrays } from "./strays.ts";

const fakeDeps = (script: ActiveRun[][]) => {
  const cancelled: string[] = [];
  let clock = 0;
  let polls = 0;

  return {
    cancelled,
    deps: {
      listActive: async () => {
        const active = script[Math.min(polls, script.length - 1)] ?? [];

        polls += 1;

        return active;
      },
      cancel: async (runId: string) => {
        cancelled.push(runId);
      },
      sleep: async (ms: number) => {
        clock += ms;
      },
      now: () => {
        return clock;
      },
    },
  };
};

const run = (id: string, functionId: string, eventId: string): ActiveRun => {
  return { id, functionId, eventIds: [eventId] };
};

describe("cancelStrays", () => {
  test("cancels unfinished runs of the session's events, and no others", async () => {
    const { cancelled, deps } = fakeDeps([
      [
        run("a", "pr", "evt-1"),
        run("b", "docs", "evt-1"),
        run("c", "other", "evt-9"),
        run("d", "pr/cleanup", "evt-1"),
      ],
      [],
    ]);

    const result = await cancelStrays({
      eventIds: ["evt-1"],
      graceMs: 10_000,
      pollMs: 100,
      deps,
    });

    expect(result).toEqual(["a", "b"]);
    expect(cancelled).toEqual(["a", "b"]);
  });

  test("does nothing when nothing is left running", async () => {
    const { cancelled, deps } = fakeDeps([[]]);

    await cancelStrays({
      eventIds: ["evt-1"],
      graceMs: 10_000,
      pollMs: 100,
      deps,
    });

    expect(cancelled).toEqual([]);
  });

  test("waits for cleanup runs, but only for the grace period", async () => {
    let polls = 0;
    const { deps } = fakeDeps([]);

    deps.listActive = async () => {
      polls += 1;

      return [run("a", "pr", "evt-1"), run("z", "pr/cleanup", "evt-2")];
    };

    await cancelStrays({
      eventIds: ["evt-1"],
      graceMs: 1000,
      pollMs: 100,
      deps,
    });

    expect(polls).toBeGreaterThan(2);
    expect(polls).toBeLessThanOrEqual(12);
  });

  test("never throws when the Dev Server can't be asked", async () => {
    const { deps } = fakeDeps([]);

    deps.listActive = async () => {
      throw new Error("gone");
    };

    await expect(
      cancelStrays({ eventIds: ["evt-1"], graceMs: 1000, pollMs: 100, deps }),
    ).resolves.toEqual([]);
  });
});
