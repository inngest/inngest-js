/**
 * Tests for the reducer: ordering, retries, dedup and terminal states.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import type { SessionEvent } from "../events.ts";
import {
  displayActivity,
  initialModel,
  type Model,
  reduce,
  runsStartedAt,
} from "./model.ts";

const play = (events: SessionEvent[]): Model => {
  return events.reduce(reduce, initialModel);
};

const run = (status: "running" | "passed" | "failed", at: number) => {
  return {
    kind: "run",
    eventId: "e1",
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

  test("starts over when new targets are chosen", () => {
    const model = play([
      run("running", 1),
      run("passed", 2),
      { kind: "done", conclusion: "passed", at: 3 },
      { kind: "targets", targets: [{ kind: "job", id: "lint" }], at: 4 },
    ]);

    expect(model).toMatchObject({
      runs: [],
      conclusion: undefined,
      endedAt: undefined,
      targets: { at: 4 },
    });
    expect(runsStartedAt(model)).toBe(4);
  });

  test("shows an activity until a command or the end of the job", () => {
    const activity = (text: string, at: number): SessionEvent => {
      return { kind: "activity", runId: "r1", jobId: "test", text, at };
    };
    const jobActivity = (events: SessionEvent[]) => {
      return play([run("running", 0), job("test", "running", 1), ...events])
        .runs[0]?.jobs[0]?.activity;
    };

    expect(jobActivity([activity("creating machine…", 2)])).toBe(
      "creating machine…",
    );
    expect(
      jobActivity([activity("creating machine…", 2), command(1, "running", 3)]),
    ).toBeUndefined();
    expect(
      jobActivity([activity("pausing machine…", 2), job("test", "passed", 3)]),
    ).toBeUndefined();
    expect(
      jobActivity([job("test", "passed", 2), activity("pausing machine…", 3)]),
    ).toBeUndefined();
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
      { kind: "done", conclusion: "failed", at: 10 },
    ]);

    expect(model.runs[0]).toMatchObject({ status: "failed", endedAt: 9 });
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

describe("warnings", () => {
  test("are kept on their run, each once", () => {
    const warning = {
      kind: "warning",
      runId: "r1",
      text: "base is slow",
      at: 5,
    } as const;

    const model = play([run("running", 0), warning, warning]);

    expect(model.runs[0]?.warnings).toEqual(["base is slow"]);
  });

  test("for a run that isn't announced are dropped", () => {
    const model = play([
      { kind: "warning", runId: "nope", text: "lost", at: 1 },
    ]);

    expect(model.runs).toEqual([]);
  });
});

describe("restart", () => {
  test("forgets the attempt that failed, keeping only when it began", () => {
    const model = play([
      { kind: "stage", stage: "app", status: "failed", at: 5 },
      { kind: "setup-error", message: "The app exited.", at: 6 },
      { kind: "done", conclusion: "setup-error", at: 7 },
      { kind: "restart", at: 8 },
    ]);

    expect(model).toEqual({ stages: [], runs: [], startedAt: 8 });
  });
});

describe("a run that ends with jobs still open", () => {
  const failed = (reason?: string) => {
    return { ...run("failed", 9), ...(reason ? { reason } : {}) } as const;
  };

  test("fails the one job that was active, with the run's reason", () => {
    const model = play([
      run("running", 0),
      job("base", "passed", 1),
      job("lint", "running", 2),
      failed("Sandbox did not reach RUNNING"),
    ]);

    expect(model.runs[0]?.reason).toBe("Sandbox did not reach RUNNING");

    expect(
      model.runs[0]?.jobs.map((item) => {
        return [item.jobId, item.status, item.title, item.endedAt];
      }),
    ).toEqual([
      ["base", "passed", undefined, 1],
      ["lint", "failed", "Sandbox did not reach RUNNING", 9],
    ]);
  });

  test("cancels the open jobs when it can't tell which was active", () => {
    const model = play([
      run("running", 0),
      job("lint", "running", 1),
      job("test", "queued", 2),
      failed("boom"),
    ]);

    expect(
      model.runs[0]?.jobs.map((item) => {
        return [item.status, item.title];
      }),
    ).toEqual([
      ["cancelled", "Cancelled: the run ended first"],
      ["cancelled", "Cancelled: the run ended first"],
    ]);
  });

  test("a cancelled run cancels its open jobs", () => {
    const model = play([
      run("running", 0),
      job("lint", "running", 1),
      { ...run("failed", 5), status: "cancelled" },
    ]);

    expect(model.runs[0]?.jobs[0]?.status).toBe("cancelled");
  });

  test("a passed run leaves its jobs alone", () => {
    const model = play([
      run("running", 0),
      job("lint", "running", 1),
      { ...run("failed", 5), status: "passed" },
    ]);

    expect(model.runs[0]?.jobs[0]?.status).toBe("running");
  });
});

describe("a job in a run of its own", () => {
  test("keeps the URL of the run that builds it, through the job's end", () => {
    const model = play([
      run("running", 0),
      job("base", "running", 1),
      { ...job("base", "running", 2), url: "http://build" },
      job("base", "passed", 3),
      { ...job("base", "running", 4), url: "http://build" },
    ]);

    expect(model.runs[0]?.jobs[0]).toMatchObject({
      status: "passed",
      url: "http://build",
    });
  });

  test("shows the commands the build run sends under the job", () => {
    const model = play([
      run("running", 0),
      job("base", "running", 1),
      {
        kind: "command",
        runId: "r1",
        jobId: "base",
        commandId: "c1",
        name: "pnpm install",
        attempt: 1,
        status: "running",
        at: 2,
      },
    ]);

    expect(model.runs).toHaveLength(1);
    expect(model.runs[0]?.jobs[0]?.commands[0]?.name).toBe("pnpm install");
  });
});

describe("a job waiting for its parent", () => {
  const activity = (jobId: string, text: string, at: number) => {
    return { kind: "activity", runId: "r1", jobId, text, at } as const;
  };

  const waiting = (events: SessionEvent[]) => {
    const model = play([
      run("running", 0),
      job("base", "running", 1),
      job("test", "running", 2, { parentId: "base" }),
      activity("test", "waiting for base…", 3),
      ...events,
    ]);
    const [parent, child] = model.runs[0]?.jobs ?? [];

    return child && model.runs[0]
      ? displayActivity(model.runs[0], child)
      : parent;
  };

  test("says plainly that it waits while the parent is idle or unknown", () => {
    expect(waiting([])).toBe("waiting for base");
  });

  test("mirrors the parent as it checks the cache, runs a command and builds", () => {
    expect(waiting([activity("base", "checking cache…", 4)])).toBe(
      "waiting for base · checking cache",
    );

    expect(
      waiting([
        activity("base", "checking cache…", 4),
        {
          kind: "command",
          runId: "r1",
          jobId: "base",
          commandId: "c1",
          name: "pnpm install",
          attempt: 1,
          status: "running",
          at: 5,
        },
      ]),
    ).toBe("waiting for base · $ pnpm install");

    expect(
      waiting([
        activity("base", "checking cache…", 4),
        activity("base", "building in its own run", 5),
      ]),
    ).toBe("waiting for base · building in its own run");
  });

  test("goes back to plain once the parent's command finishes", () => {
    expect(
      waiting([
        {
          kind: "command",
          runId: "r1",
          jobId: "base",
          commandId: "c1",
          name: "pnpm install",
          attempt: 1,
          status: "passed",
          at: 5,
        },
      ]),
    ).toBe("waiting for base");
  });

  test("leaves other activity as it is", () => {
    const model = play([
      run("running", 0),
      job("test", "running", 1),
      activity("test", "creating machine…", 2),
    ]);

    expect(
      model.runs[0] && model.runs[0].jobs[0]
        ? displayActivity(model.runs[0], model.runs[0].jobs[0])
        : undefined,
    ).toBe("creating machine…");
  });
});
