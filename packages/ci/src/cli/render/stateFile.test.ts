/**
 * Tests for the state file: the model-to-file mapping, the write throttle and
 * the atomic write.
 *
 * @module
 */

import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { SessionEvent } from "../events.ts";
import { initialModel, reduce } from "./model.ts";
import {
  createStateFileRenderer,
  describeStarter,
  toSessionState,
  writeFileAtomic,
} from "./stateFile.ts";

const meta = {
  sessionId: "abc",
  pid: 42,
  startedBy: { kind: "user" },
  cwd: "/work/ci-pipelines",
} as const;

const pipelineRun: SessionEvent[] = [
  { kind: "project", root: "/work/ci-pipelines", at: 1 },
  {
    kind: "ready",
    devServerUrl: "http://127.0.0.1:1",
    devServerDir: "/db/s1",
    repo: { fullName: "a/b", ref: "main", sha: "abc", dirty: true },
    at: 2,
  },
  {
    kind: "targets",
    targets: [{ kind: "pipeline", id: "pr", trigger: "pull_request.opened" }],
    at: 2,
  },
  {
    kind: "run",
    eventId: "e1",
    runId: "r1",
    pipelineId: "pr",
    status: "running",
    url: "u",
    at: 3,
  },
  { kind: "job", runId: "r1", jobId: "base", status: "passed", at: 4 },
  {
    kind: "job",
    runId: "r1",
    jobId: "test (node 20)",
    status: "failed",
    parentId: "base",
    title: "exited with 1",
    at: 5,
  },
  {
    kind: "job",
    runId: "r1",
    jobId: "test (node 22)",
    status: "running",
    parentId: "base",
    at: 6,
  },
  {
    kind: "command",
    runId: "r1",
    jobId: "test (node 20)",
    commandId: "c1",
    name: "pnpm test",
    attempt: 1,
    status: "failed",
    at: 7,
  },
  {
    kind: "command",
    runId: "r1",
    jobId: "test (node 20)",
    commandId: "c1",
    name: "pnpm test",
    attempt: 2,
    status: "failed",
    at: 8,
  },
  {
    kind: "run",
    eventId: "e1",
    runId: "r1",
    pipelineId: "pr",
    status: "failed",
    url: "u",
    at: 9,
  },
  { kind: "done", conclusion: "failed", at: 10 },
];

describe("toSessionState", () => {
  test("maps a pipeline run with from() and a matrix", () => {
    const model = pipelineRun.reduce(reduce, initialModel);
    const state = toSessionState(model, meta, 99);

    expect(state).toMatchObject({
      v: 1,
      sessionId: "abc",
      pid: 42,
      startedAt: 1,
      updatedAt: 99,
      endedAt: 10,
      conclusion: "failed",
      project: { root: "/work/ci-pipelines", name: "ci-pipelines" },
      repo: { fullName: "a/b", dirty: true },
      devServerUrl: "http://127.0.0.1:1",
      devServerDir: "/db/s1",
      target: { kind: "pipeline", id: "pr", trigger: "pull_request.opened" },
    });
    expect(state.runs[0]).toMatchObject({
      runId: "r1",
      pipelineId: "pr",
      status: "failed",
      endedAt: 9,
    });
    expect(
      state.runs[0]?.jobs.map((job) => {
        return job.id;
      }),
    ).toEqual(["base", "test (node 20)", "test (node 22)"]);
    expect(state.runs[0]?.jobs[1]).toMatchObject({
      parentId: "base",
      title: "exited with 1",
      command: { name: "pnpm test", attempt: 2, status: "failed" },
    });
  });

  test("is running with no end until done", () => {
    const model = pipelineRun.slice(0, 4).reduce(reduce, initialModel);
    const state = toSessionState(model, meta, 99);

    expect(state.conclusion).toBe("running");
    expect(state.endedAt).toBeUndefined();
  });
});

describe("describeStarter", () => {
  test("says whether Claude Code started it", () => {
    expect(describeStarter({})).toEqual({ kind: "user" });
    expect(describeStarter({ CLAUDECODE: "1" })).toEqual({ kind: "claude" });
    expect(describeStarter({ CLAUDE_CODE_SESSION_ID: "s1" })).toEqual({
      kind: "claude",
      sessionId: "s1",
    });
  });
});

describe("throttle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("writes at most once per window, with a trailing write", async () => {
    const writes: string[] = [];
    const renderer = createStateFileRenderer({
      ...meta,
      file: "/f.json",
      write: async (_, content) => {
        writes.push(content);
      },
    });

    for (const event of pipelineRun.slice(0, 5)) {
      renderer.handle(event);
    }

    await vi.advanceTimersByTimeAsync(0);

    expect(writes).toHaveLength(1);

    for (const event of pipelineRun.slice(5)) {
      renderer.handle(event);
    }

    await vi.advanceTimersByTimeAsync(249);

    expect(writes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);

    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]!).conclusion).toBe("failed");
  });

  test("close writes the final state before resolving", async () => {
    const writes: string[] = [];
    const renderer = createStateFileRenderer({
      ...meta,
      file: "/f.json",
      write: async (_, content) => {
        writes.push(content);
      },
    });

    await vi.advanceTimersByTimeAsync(0);

    for (const event of pipelineRun) {
      renderer.handle(event);
    }

    expect(writes.map((content) => JSON.parse(content).closedAt)).toEqual([
      undefined,
    ]);

    await renderer.close();

    expect(JSON.parse(writes.at(-1)!)).toMatchObject({
      conclusion: "failed",
      endedAt: 10,
      closedAt: Date.now(),
    });
  });
});

describe("writeFileAtomic", () => {
  test("creates the directory and leaves no temporary file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-write-"));
    const file = join(dir, "sessions", "s.json");

    await writeFileAtomic(file, "1");
    await writeFileAtomic(file, "2");

    expect(readFileSync(file, "utf8")).toBe("2");
    expect(readdirSync(join(dir, "sessions"))).toEqual(["s.json"]);
  });
});

describe("a run that failed with a reason", () => {
  test("the file's run carries the reason and its jobs end", () => {
    const reason = "Sandbox did not reach RUNNING within 120000 milliseconds";
    const model = (
      [
        {
          kind: "run",
          eventId: "e1",
          runId: "r1",
          pipelineId: "pr",
          status: "running",
          url: "u",
          at: 1,
        },
        { kind: "job", runId: "r1", jobId: "lint", status: "running", at: 2 },
        {
          kind: "run",
          eventId: "e1",
          runId: "r1",
          pipelineId: "pr",
          status: "failed",
          reason,
          url: "u",
          at: 3,
        },
      ] as SessionEvent[]
    ).reduce(reduce, initialModel);
    const [run] = toSessionState(model, meta, 9).runs;

    expect(run).toMatchObject({ status: "failed", reason });
    expect(run?.jobs[0]).toMatchObject({
      status: "failed",
      title: reason,
      endedAt: 3,
    });
  });
});
