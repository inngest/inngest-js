/**
 * @module
 * Tests for placing a message against what a thread was doing when it arrived.
 */
import type { ThreadRecord } from "./thread.ts";
import { statusAt, withTransition } from "./threadState.ts";

const record = (extra: Partial<ThreadRecord> = {}): ThreadRecord => {
  return {
    status: "idle",
    turn: 0,
    usage: { input: 0, output: 0 },
    ...extra,
  };
};

describe("withTransition", () => {
  test("notes a change of status with its time, and nothing when it stays", () => {
    const running = withTransition(
      record({ runId: "r1" }),
      record({ status: "running", runId: "r1" }),
      100,
    );

    expect(running.transitions).toEqual([
      { status: "idle", at: 0 },
      { status: "running", at: 100 },
    ]);
    expect(withTransition(running, { ...running }, 200)).toEqual(running);
  });

  test("a new run on the same status is a change, so a stale record cannot hold a gap busy", () => {
    const stale = record({ status: "running", runId: "r1" });
    const next = withTransition(stale, { ...stale, runId: "r2" }, 300);

    expect(next.transitions?.at(-1)).toEqual({ status: "running", at: 300 });
  });

  test("a record written before changes were kept starts with the status it had", () => {
    const next = withTransition(
      record({ status: "running" }),
      record({ status: "idle" }),
      500,
    );

    expect(next.transitions).toEqual([
      { status: "running", at: 0 },
      { status: "idle", at: 500 },
    ]);
  });

  test("keeps only the latest", () => {
    let current = record();

    for (let n = 1; n <= 100; n++) {
      current = withTransition(
        current,
        { ...current, status: n % 2 ? "running" : "waiting" },
        n,
      );
    }

    expect(current.transitions).toHaveLength(64);
    expect(current.transitions?.at(-1)).toEqual({ status: "waiting", at: 100 });
  });
});

describe("statusAt", () => {
  const found = record({
    status: "waiting",
    transitions: [
      { status: "running", at: 100 },
      { status: "waiting", at: 200 },
    ],
  });

  test("is the latest change at or before the time", () => {
    expect(statusAt(found, 150)).toBe("running");
    expect(statusAt(found, 200)).toBe("waiting");
    expect(statusAt(found, 999)).toBe("waiting");
  });

  test("is idle before the first change, and for a thread with no record", () => {
    expect(statusAt(found, 50)).toBe("idle");
    expect(statusAt(undefined, 50)).toBe("idle");
  });

  test("is the current status with no time, or with no changes kept", () => {
    expect(statusAt(found, undefined)).toBe("waiting");
    expect(statusAt(record({ status: "running" }), 10)).toBe("running");
  });
});
