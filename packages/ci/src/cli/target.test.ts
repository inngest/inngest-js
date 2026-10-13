/**
 * Tests for resolving a target against the manifest and building events.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import type { LocalManifest } from "../local/protocol.ts";
import type { SetupError } from "./setupError.ts";
import {
  buildJobEvent,
  buildPipelineEvent,
  describeCombo,
  describeCombos,
  type LocalRepo,
  listTargets,
  matchTrigger,
  resolveTarget,
  selectCombos,
  type Target,
  targetsOf,
  triggerEvents,
} from "./target.ts";

const manifest: LocalManifest = {
  pipelines: [
    {
      id: "pr",
      triggers: [
        { event: "github/pull_request.opened" },
        { event: "github/push" },
      ],
    },
    { id: "lint", triggers: [{ cron: "0 3 * * *" }] },
  ],
  jobs: [
    { id: "lint", takesInput: false },
    { id: "test", takesInput: true },
  ],
  matrices: [
    {
      id: "compat",
      axes: { os: ["linux", "mac"], node: [20, 22] },
      // `exclude` took mac on 22 and `include` added node 18 on linux.
      combos: [
        { os: "linux", node: 20 },
        { os: "linux", node: 22 },
        { os: "mac", node: 20 },
        { os: "linux", node: 18 },
      ],
    },
  ],
};

const repo: LocalRepo = {
  fullName: "acme/app",
  ref: "main",
  sha: "abc1234",
  dirty: false,
  fixtureData: { local: { path: "/work", baseRef: "main" } },
};

describe("resolveTarget", () => {
  test("finds a pipeline, a job and a matrix", () => {
    expect(resolveTarget(manifest, { name: "pr" })).toMatchObject({
      kind: "pipeline",
      id: "pr",
    });
    expect(resolveTarget(manifest, { name: "test" })).toEqual({
      kind: "job",
      id: "test",
      takesInput: true,
    });
    expect(resolveTarget(manifest, { name: "compat" })).toMatchObject({
      kind: "job",
      axes: { os: ["linux", "mac"], node: [20, 22, 18] },
      combos: manifest.matrices[0]?.combos,
    });
  });

  test("asks for --pipeline or --job when a name is both", () => {
    expect(() => resolveTarget(manifest, { name: "lint" })).toThrow(
      /both a pipeline and a job/,
    );
    expect(resolveTarget(manifest, { pipeline: "lint" }).kind).toBe("pipeline");
    expect(resolveTarget(manifest, { job: "lint" }).kind).toBe("job");
  });

  test("lists what exists for an unknown name", () => {
    expect.assertions(2);

    try {
      resolveTarget(manifest, { name: "nope" });
    } catch (error) {
      expect((error as SetupError).message).toContain("nope");
      expect((error as SetupError).fix).toContain("compat");
    }
  });
});

describe("targetsOf", () => {
  test("lists pipelines, then jobs, then matrices", () => {
    expect(
      targetsOf(manifest).map((target) => {
        return `${target.kind}:${target.id}${target.axes ? " (matrix)" : ""}`;
      }),
    ).toEqual([
      "pipeline:pr",
      "pipeline:lint",
      "job:lint",
      "job:test",
      "job:compat (matrix)",
    ]);
  });

  test("says what can run, for an error", () => {
    expect(listTargets(manifest)).toBe(
      "Pipelines: pr, lint\nJobs: lint, test, compat",
    );
  });
});

describe("triggerEvents and matchTrigger", () => {
  const { triggers } = manifest.pipelines[0] as (typeof manifest.pipelines)[0];

  test("lists the events, and rejects crons", () => {
    expect(triggerEvents(triggers)).toEqual([
      "github/pull_request.opened",
      "github/push",
    ]);
    expect(() => triggerEvents([{ cron: "0 3 * * *" }])).toThrow(/Cron/);
  });

  test("matches a name with or without the github/ prefix", () => {
    const events = triggerEvents(triggers);

    expect(matchTrigger(events, "push")).toBe("github/push");
    expect(matchTrigger(events, "github/push")).toBe("github/push");
    expect(() => matchTrigger(events, "nope")).toThrow(/no "nope" trigger/);
  });
});

describe("buildPipelineEvent", () => {
  test("sends --data on a manual trigger, with the repository", async () => {
    const event = await buildPipelineEvent({
      pipelineId: "p",
      trigger: "ci/manual.deploy",
      data: { env: "prod" },
      cwd: process.cwd(),
    });

    expect(event.name).toBe("ci/manual.deploy");
    expect(event.data).toMatchObject({
      env: "prod",
      repository: { full_name: expect.any(String) },
      local: { path: process.cwd() },
    });
  });

  test("builds a push fixture", async () => {
    const event = await buildPipelineEvent({
      pipelineId: "p",
      trigger: "github/push",
      cwd: process.cwd(),
    });

    expect(event.name).toBe("github/push");
    expect(event.data.local).toBeDefined();
  });

  test("a comment trigger needs a body", async () => {
    await expect(
      buildPipelineEvent({
        pipelineId: "p",
        trigger: "github/issue_comment.created",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/comment's text/);
  });

  test("rejects a trigger with no fixture", async () => {
    await expect(
      buildPipelineEvent({
        pipelineId: "p",
        trigger: "github/merge_group.checks_requested",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/no local fixture/);
  });
});

describe("selectCombos", () => {
  const compat = resolveTarget(manifest, { name: "compat" }) as Extract<
    Target,
    { kind: "job" }
  >;

  test("is undefined with no flags, to run every combination", () => {
    expect(selectCombos(compat, {})).toBeUndefined();
  });

  test("matches flag text to the axis's own values", () => {
    expect(selectCombos(compat, { os: ["mac"], node: ["20"] })).toEqual([
      { os: "mac", node: 20 },
    ]);
  });

  test("a repeated axis takes all its values, and a missing axis takes any", () => {
    expect(selectCombos(compat, { node: ["20", "22"] })).toEqual([
      { os: "linux", node: 20 },
      { os: "linux", node: 22 },
      { os: "mac", node: 20 },
    ]);
    expect(selectCombos(compat, { node: ["20", "22"], os: ["linux"] })).toEqual(
      [
        { os: "linux", node: 20 },
        { os: "linux", node: 22 },
      ],
    );
  });

  test("only picks combinations the matrix really has", () => {
    expect(() => selectCombos(compat, { os: ["mac"], node: ["22"] })).toThrow(
      /No combination/,
    );
  });

  test("finds a value only an include adds", () => {
    expect(selectCombos(compat, { node: ["18"] })).toEqual([
      { os: "linux", node: 18 },
    ]);
  });

  test("rejects unknown axes, unknown values and non-matrix jobs", () => {
    expect(() => selectCombos(compat, { arch: ["x"] })).toThrow(
      /Unknown option --arch/,
    );
    expect(() => selectCombos(compat, { os: ["bsd"] })).toThrow(
      /isn't a value of os/,
    );
    expect(() =>
      selectCombos(
        { kind: "job", id: "lint", takesInput: false },
        { os: ["a"] },
      ),
    ).toThrow(/isn't a matrix/);
  });
});

describe("buildJobEvent", () => {
  test("carries the repository, input and combinations", () => {
    const event = buildJobEvent({
      target: {
        kind: "job",
        id: "compat",
        takesInput: false,
        axes: { os: ["linux"] },
      },
      repo,
      input: { a: 1 },
      combos: [{ os: "linux" }],
    });

    expect(event).toEqual({
      name: "ci/run-job",
      data: {
        ...repo.fixtureData,
        job: "compat",
        input: { a: 1 },
        combos: [{ os: "linux" }],
      },
    });
  });

  test("leaves the combinations out to run every one", () => {
    const target: Extract<Target, { kind: "job" }> = {
      kind: "job",
      id: "compat",
      takesInput: false,
      axes: { os: ["linux"] },
    };

    expect(buildJobEvent({ target, repo }).data.combos).toBeUndefined();
  });
});

describe("describing combinations", () => {
  test("a combination reads as a job names it", () => {
    expect(describeCombo({ os: "linux", node: 22 })).toBe("os:linux, node:22");
  });

  test("a selection reads as the one combination, or how many", () => {
    expect(describeCombos([{ os: "linux", node: 22 }])).toBe(
      "os:linux, node:22",
    );
    expect(describeCombos([{ os: "linux" }, { os: "mac" }])).toBe(
      "2 combinations",
    );
  });
});
