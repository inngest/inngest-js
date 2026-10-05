/**
 * Tests for the reducer: ordering, retries, dedup and terminal states.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import type { SessionEvent } from "../events.ts";
import { initialModel, type Model, reduce } from "./model.ts";

const play = (events: SessionEvent[]): Model => {
  return events.reduce(reduce, initialModel);
};

const run = (status: "running" | "passed" | "failed", at: number) => {
  return {
    kind: "run",
    runId: "r1",
    pipelineId: "pr",
    status,
    url: "http://run",
    at,
  } as const;
};

const job = (
  jobId: string,
  status: "queued" | "running" | "passed" | "failed",
  at: number,
  extra: { parentId?: string; title?: string } = {},
) => {
  return { kind: "job", runId: "r1", jobId, status, at, ...extra } as const;
};

const command = (
  attempt: number,
  status: "running" | "passed" | "failed",
  at: number,
) => {
  return {
    kind: "command",
    runId: "r1",
    jobId: "test",
    commandId: "c1",
    name: "pnpm test",
    attempt,
    status,
    at,
  } as const;
};

describe("reduce", () => {
  test("keeps jobs in order of first appearance", () => {
    const model = play([
      run("running", 0),
      job("b", "running", 1),
      job("a", "running", 2),
      job("b", "passed", 3),
    ]);

    expect(model.runs[0]?.jobs.map((item) => item.jobId)).toEqual(["b", "a"]);
  });

  test("the latest message for a job wins and a repeat adds no row", () => {
    const model = play([
      run("running", 0),
      job("lint", "running", 1),
      job("lint", "passed", 5),
      job("lint", "passed", 5),
    ]);
    const jobs = model.runs[0]?.jobs;

    expect(jobs).toHaveLength(1);
    expect(jobs?.[0]).toMatchObject({
      status: "passed",
      startedAt: 1,
      endedAt: 5,
    });
  });

  test("a job's clock starts when it leaves the queue", () => {
    const model = play([
      run("running", 0),
      job("lint", "queued", 1),
      job("lint", "running", 4),
    ]);

    expect(model.runs[0]?.jobs[0]).toMatchObject({
      startedAt: 4,
      endedAt: undefined,
    });
  });

  test("remembers a job's parent and title when later messages omit them", () => {
    const model = play([
      run("running", 0),
      job("lint", "running", 1, { parentId: "base" }),
      job("lint", "failed", 2, { title: "exited with 1" }),
    ]);

    expect(model.runs[0]?.jobs[0]).toMatchObject({
      parentId: "base",
      title: "exited with 1",
    });
  });

  test("collapses a command's attempts into one entry", () => {
    const model = play([
      run("running", 0),
      job("test", "running", 1),
      command(1, "failed", 2),
      command(2, "running", 3),
    ]);
    const commands = model.runs[0]?.jobs[0]?.commands;

    expect(commands).toHaveLength(1);
    expect(commands?.[0]).toMatchObject({ attempt: 2, status: "running" });
  });

  test("drops jobs and commands for a run it hasn't seen", () => {
    const model = play([job("lint", "running", 1), command(1, "running", 2)]);

    expect(model.runs).toEqual([]);
  });

  test("names a single-job run after its target", () => {
    const model = play([
      {
        kind: "ready",
        devServerUrl: "http://dev",
        repo: { fullName: "a/b", ref: "main", sha: "abc", dirty: false },
        target: { kind: "job", id: "lint" },
        at: 0,
      },
      { ...run("running", 1), pipelineId: "ci-run-job" },
    ]);

    expect(model.runs[0]?.name).toBe("lint");
  });

  test("tracks stages and keeps their detail", () => {
    const model = play([
      { kind: "stage", stage: "app", status: "running", detail: "x", at: 1 },
      { kind: "stage", stage: "app", status: "done", at: 4 },
    ]);

    expect(model.stages).toEqual([
      { stage: "app", status: "done", detail: "x", startedAt: 1, endedAt: 4 },
    ]);
  });

  test("records a setup error and the conclusion", () => {
    const model = play([
      { kind: "setup-error", message: "no config", fix: "add it", at: 1 },
      { kind: "done", conclusion: "setup-error", at: 3 },
    ]);

    expect(model.setupError?.message).toBe("no config");
    expect(model).toMatchObject({
      conclusion: "setup-error",
      startedAt: 1,
      endedAt: 3,
    });
  });

  test("ends a run that finishes", () => {
    const model = play([
      run("running", 0),
      run("failed", 9),
      { kind: "done", conclusion: "failed", runUrl: "http://run", at: 10 },
    ]);

    expect(model.runs[0]).toMatchObject({ status: "failed", endedAt: 9 });
    expect(model.runUrl).toBe("http://run");
  });

  test("ignores the manifest and doesn't mutate the previous model", () => {
    const before = play([run("running", 0)]);
    const after = reduce(before, job("lint", "running", 1));

    expect(
      reduce(before, {
        kind: "manifest",
        manifest: {
          pipelines: [],
          jobs: [],
          matrices: [],
        },
      }),
    ).toBe(before);
    expect(before.runs[0]?.jobs).toEqual([]);
    expect(after.runs[0]?.jobs).toHaveLength(1);
  });
});
