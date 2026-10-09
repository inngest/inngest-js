/**
 * Tests for matching messages to the runs a session sent, and for how several
 * runs conclude together.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import type { LocalMessage } from "../local/protocol.ts";
import { combineConclusions, createRouter } from "./runs.ts";

const lint = { eventId: "e1", functionId: "ci-run-job", name: "lint" };
const unit = { eventId: "e2", functionId: "ci-run-job", name: "test" };
const pr = { eventId: "e3", functionId: "pr", name: "pr" };

const run = (
  runId: string,
  eventId: string,
  pipelineId: string,
): LocalMessage => {
  return {
    kind: "run",
    runId,
    eventId,
    pipelineId,
    status: "running",
    url: "u",
    at: 0,
  };
};

const job = (runId: string): LocalMessage => {
  return { kind: "job", runId, jobId: "j", status: "running", at: 0 };
};

describe("createRouter", () => {
  test("tells runs of one function apart by their event", () => {
    const route = createRouter([lint, unit]);

    expect(route(run("r1", "e2", "ci-run-job"))).toBe(unit);
    expect(route(run("r2", "e1", "ci-run-job"))).toBe(lint);
  });

  test("sends a run's other messages to the run it announced", () => {
    const route = createRouter([lint, unit]);

    route(run("r1", "e1", "ci-run-job"));
    route(run("r2", "e2", "ci-run-job"));

    expect(route(job("r2"))).toBe(unit);
    expect(route(job("r1"))).toBe(lint);
  });

  test("ignores pipelines the same event started that weren't sent", () => {
    const route = createRouter([pr]);

    expect(route(run("r1", "e3", "docs"))).toBeUndefined();
    expect(route(job("r1"))).toBeUndefined();
    expect(route(run("r2", "e3", "pr"))).toBe(pr);
  });

  test("ignores runs of other events, the manifest and unannounced runs", () => {
    const route = createRouter([lint]);

    expect(route(run("r1", "other", "ci-run-job"))).toBeUndefined();
    expect(route(job("r9"))).toBeUndefined();
    expect(
      route({
        kind: "manifest",
        manifest: { pipelines: [], jobs: [], matrices: [] },
      }),
    ).toBeUndefined();
  });
});

describe("combineConclusions", () => {
  test("passes only when every run passed", () => {
    expect(combineConclusions(["passed", "passed"])).toBe("passed");
  });

  test("fails when any run failed, even if another was cancelled", () => {
    expect(combineConclusions(["passed", "failed"])).toBe("failed");
    expect(combineConclusions(["cancelled", "failed", "passed"])).toBe(
      "failed",
    );
  });

  test("is cancelled when one was and none failed", () => {
    expect(combineConclusions(["passed", "cancelled"])).toBe("cancelled");
  });
});
