/**
 * @module
 * Which moments a change in the runs makes: a run finishing or failing, an
 * agent finishing, a message arriving and a tool call.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TraceRun, TraceStep } from "../shared/types.ts";
import { momentsOf } from "../site/src/sound/moments.ts";

const step = (id: string, extra: Partial<TraceStep> = {}): TraceStep => {
  return {
    id,
    name: id,
    op: null,
    status: "COMPLETED",
    attempts: 1,
    duration: 1,
    startedAt: null,
    endedAt: null,
    outputID: null,
    userland: true,
    type: "step.run",
    group: null,
    children: [],
    ...extra,
  };
};

const run = (id: string, extra: Partial<TraceRun> = {}): TraceRun => {
  return {
    id,
    fn: "tour-echo",
    status: "RUNNING",
    queuedAt: "2026-11-02T00:00:00Z",
    startedAt: null,
    endedAt: null,
    output: null,
    trigger: null,
    steps: [],
    ...extra,
  };
};

const message = {
  id: "e1",
  name: "agent/message",
  data: {},
  ts: 1,
  seq: 1,
};

describe("moments from runs", () => {
  it("is quiet for the runs already there when the site loads", () => {
    assert.deepEqual(momentsOf(null, [run("a", { status: "COMPLETED" })]), []);
  });

  it("says a message arrived when a new run starts from one", () => {
    assert.deepEqual(momentsOf([], [run("a", { trigger: message })]), [
      "message",
    ]);
  });

  it("says a run is done when a run Run started completes", () => {
    const before = [run("a")];
    const after = [run("a", { status: "COMPLETED" })];

    assert.deepEqual(momentsOf(before, after), ["runDone"]);
  });

  it("says a run failed", () => {
    assert.deepEqual(momentsOf([run("a")], [run("a", { status: "FAILED" })]), [
      "runFail",
    ]);
  });

  it("says an agent finished when a message-started run completes", () => {
    const before = [run("a", { trigger: message })];
    const after = [run("a", { trigger: message, status: "COMPLETED" })];

    assert.deepEqual(momentsOf(before, after), ["agentDone"]);
  });

  it("says each run finished only once", () => {
    const done = [run("a", { status: "COMPLETED" })];

    assert.deepEqual(momentsOf(done, done), []);
  });

  it("says a tool was called for each new tool step", () => {
    const before = [run("a", { steps: [step("tool:search")] })];
    const after = [
      run("a", {
        steps: [step("tool:search"), step("tool:fetch"), step("plain")],
      }),
    ];

    assert.deepEqual(momentsOf(before, after), ["tool"]);
  });

  it("finds tool steps inside groups", () => {
    const after = [
      run("a", {
        steps: [step("g", { children: [step("tool:search")] })],
      }),
    ];

    assert.deepEqual(momentsOf([run("a")], after), ["tool"]);
  });
});
