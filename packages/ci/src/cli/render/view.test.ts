/**
 * Tests for formatting and frames at a fixed width, with colour off.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import type { SessionEvent } from "../events.ts";
import { createPaint, formatElapsed, truncate } from "./format.ts";
import { initialModel, reduce } from "./model.ts";
import { frame, selectableRunIds } from "./view.ts";

const paint = createPaint(false);

const events: SessionEvent[] = [
  {
    kind: "ready",
    devServerUrl: "http://127.0.0.1:1",
    devServerDir: "/db/s1",
    repo: { fullName: "a/b", ref: "main", sha: "70f798f1234", dirty: true },
    at: 0,
  },
  {
    kind: "targets",
    targets: [{ kind: "pipeline", id: "pr", trigger: "pull_request.opened" }],
    at: 0,
  },
  {
    kind: "run",
    eventId: "e1",
    runId: "r1",
    pipelineId: "pr",
    status: "running",
    url: "http://run",
    at: 0,
  },
  { kind: "job", runId: "r1", jobId: "base", status: "running", at: 1000 },
  { kind: "job", runId: "r1", jobId: "base", status: "cached", at: 2000 },
  {
    kind: "job",
    runId: "r1",
    jobId: "test",
    status: "running",
    parentId: "base",
    at: 1000,
  },
  {
    kind: "job",
    runId: "r1",
    jobId: "test",
    status: "failed",
    parentId: "base",
    title: "`pnpm test` exited with 1",
    at: 5000,
  },
  {
    kind: "command",
    runId: "r1",
    jobId: "test",
    commandId: "c1",
    name: "pnpm test",
    attempt: 2,
    status: "failed",
    outputTail: "boom\n\x1b[31mred\x1b[0m\n",
    at: 5000,
  },
];

const model = events.reduce(reduce, initialModel);

describe("formatElapsed", () => {
  test.each([
    [0, "0.0s"],
    [800, "0.8s"],
    [9999, "9.9s"],
    [22_400, "22s"],
    [72_000, "1m 12s"],
    [3_720_000, "1h 2m"],
    [-5, "0.0s"],
  ])("%d ms is %s", (ms, text) => {
    expect(formatElapsed(ms)).toBe(text);
  });
});

describe("truncate", () => {
  test("leaves short text alone and marks a cut", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abcd", 3)).toBe("ab…");
    expect(truncate("abcd", 0)).toBe("…");
  });
});

describe("frame", () => {
  test("draws the header, the job tree and a failure at a fixed width", () => {
    const lines = frame(model, { width: 80, now: 6000, paint });

    expect(lines).toEqual([
      "  inngest-ci pr  pull_request.opened · main @ 70f798f + uncommitted",
      "  Dev Server  http://127.0.0.1:1",
      "",
      "  ◌ pr                                                                      6.0s",
      "  └─ ✓ base     cached                                                      1.0s",
      "     └─ ✕ test  pnpm test · attempt 2                                       4.0s",
      "          `pnpm test` exited with 1",
      "          boom",
      "          red",
    ]);
  });

  test("shows a spinner while running and highlights the selection", () => {
    const lines = frame(model, {
      width: 80,
      now: 6000,
      spinner: "⠋",
      selected: 1,
      hint: "q quit",
      paint,
    });

    expect(lines[3]).toMatch(/^ {2}⠋ pr/);
    expect(lines[4]).toMatch(/^› └─ ✓ base/);
    expect(lines.at(-1)).toBe("  q quit");
  });

  test("cuts every line to a narrow width without wrapping", () => {
    const lines = frame(model, { width: 30, now: 6000, paint });

    expect(Math.max(...lines.map((line) => line.length))).toBeLessThanOrEqual(
      30,
    );
    expect(lines[5]).toContain("test");
  });

  test("ends a finished session with the outcome and the trace", () => {
    const done = reduce(model, {
      kind: "done",
      conclusion: "failed",
      at: 8000,
    });

    expect(frame(done, { width: 80, now: 9999, paint }).slice(-3)).toEqual([
      "",
      "  ✕ Failed in 8.0s",
      "  Open later  inngest-ci open r1",
    ]);
  });

  test("names several targets in the header, without their triggers", () => {
    const several = reduce(model, {
      kind: "targets",
      targets: [
        { kind: "pipeline", id: "pr", trigger: "pull_request.opened" },
        { kind: "job", id: "compat" },
      ],
      at: 10,
    });

    expect(frame(several, { width: 80, now: 11, paint })[0]).toBe(
      "  inngest-ci pr, compat  main @ 70f798f + uncommitted",
    );
  });

  test("shows what a job is doing until a command runs", () => {
    const activity: SessionEvent[] = [
      { kind: "job", runId: "r1", jobId: "lint", status: "running", at: 6000 },
      {
        kind: "activity",
        runId: "r1",
        jobId: "lint",
        text: "creating machine…",
        at: 7000,
      },
    ];
    const working = activity.reduce(reduce, model);

    expect(frame(working, { width: 80, now: 8000, paint })[9]).toContain(
      "lint     creating machine…",
    );
  });

  test("shows a stage that waits, with how long it has", () => {
    const waiting = reduce(initialModel, {
      kind: "stage",
      stage: "start",
      status: "running",
      detail: "release to start…",
      at: 1000,
    });

    expect(frame(waiting, { width: 80, now: 7000, paint })).toEqual([
      "  ◌ Waiting  release to start…                                              6.0s",
    ]);
  });

  test("shows a setup error with its fix and log", () => {
    const lines = frame(
      reduce(initialModel, {
        kind: "setup-error",
        message: "No Dev Server binary.",
        fix: "npm i -D inngest-cli",
        logTail: "last line",
        at: 1,
      }),
      { width: 80, now: 2, paint },
    );

    expect(lines).toEqual([
      "  ✕ No Dev Server binary.",
      "    npm i -D inngest-cli",
      "    last line",
    ]);
  });
});

describe("selectableRunIds", () => {
  test("lists each run, then its jobs, as the run they open", () => {
    expect(selectableRunIds(model)).toEqual(["r1", "r1", "r1"]);
  });
});

describe("a failed run's reason", () => {
  const reason = "Sandbox did not reach RUNNING within 120000 milliseconds";
  const failed = [
    {
      kind: "run",
      eventId: "e1",
      runId: "r1",
      pipelineId: "pr",
      status: "running",
      url: "u",
      at: 0,
    },
    { kind: "job", runId: "r1", jobId: "lint", status: "running", at: 1 },
    {
      kind: "run",
      eventId: "e1",
      runId: "r1",
      pipelineId: "pr",
      status: "failed",
      reason,
      url: "u",
      at: 2000,
    },
    { kind: "done", conclusion: "failed", at: 2000 },
  ] as SessionEvent[];

  test("shows on the run, the job and the summary line", () => {
    const lines = frame(failed.reduce(reduce, initialModel), {
      paint,
      now: 2000,
      width: 100,
    });

    const text = lines.join("\n");

    expect(text.split(reason).length - 1).toBe(4);
    expect(text).toContain(`✕ Failed in 2.0s — ${reason}`);
  });
});
