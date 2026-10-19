/**
 * Tests of picking a target from the manifest, choosing matrix combinations
 * and building the events.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import type { LocalManifest } from "../local/protocol.ts";
import { localTargetKey } from "../local/protocol.ts";
import type { Target } from "./target.ts";
import {
  buildJobEvent,
  buildPipelineEvent,
  matchTrigger,
  resolveTarget,
  selectCombos,
  targetsOf,
} from "./target.ts";

const manifest: LocalManifest = {
  pipelines: [
    {
      id: "pr",
      triggers: [
        { event: "github/pull_request.opened" },
        { cron: "0 0 * * *" },
      ],
    },
    { id: "nightly", triggers: [{ cron: "0 0 * * *" }] },
  ],
  jobs: [{ id: "greet", takesInput: true }],
  matrices: [
    {
      id: "compat",
      combos: [
        { node: "20", os: "linux" },
        { node: 22, os: "linux" },
        { node: 22, os: "mac" },
      ],
    },
  ],
};

const targets = targetsOf(manifest);
const compat = resolveTarget(targets, "compat") as Extract<
  Target,
  { kind: "job" }
>;

describe("targets", () => {
  test("a pipeline lists its event triggers and drops crons", () => {
    expect(resolveTarget(targets, "pr")).toMatchObject({
      kind: "pipeline",
      events: ["github/pull_request.opened"],
    });

    expect(resolveTarget(targets, "nightly")).toMatchObject({ events: [] });
  });

  test("an unknown name lists what can run", () => {
    expect(() => {
      return resolveTarget(targets, "nope");
    }).toThrow(/Nothing named "nope"/);
  });

  test("a name that is a pipeline and a job is ambiguous", () => {
    const both = targetsOf({
      ...manifest,
      jobs: [{ id: "pr", takesInput: false }],
    });

    expect(() => {
      return resolveTarget(both, "pr");
    }).toThrow(/both a pipeline and a job/);
  });

  test("a trigger can be named without github/", () => {
    expect(
      matchTrigger(["github/pull_request.opened"], "pull_request.opened"),
    ).toBe("github/pull_request.opened");

    expect(() => {
      return matchTrigger(["github/push"], "pull_request.opened");
    }).toThrow(/no "pull_request.opened" trigger/);
  });
});

describe("selectCombos", () => {
  test.each([
    ["no flags run every combination", {}, undefined],
    [
      "a value picks its combinations",
      { os: ["mac"] },
      [{ node: 22, os: "mac" }],
    ],
    [
      "flags are matched as text, so --node 22 finds 22",
      { node: ["22"] },
      [
        { node: 22, os: "linux" },
        { node: 22, os: "mac" },
      ],
    ],
    [
      "several flags narrow together",
      { node: ["22"], os: ["linux"] },
      [{ node: 22, os: "linux" }],
    ],
    [
      "an axis given twice takes both values",
      { os: ["linux", "mac"], node: ["20"] },
      [{ node: "20", os: "linux" }],
    ],
  ])("%s", (_, flags, expected) => {
    expect(selectCombos(compat, flags)).toEqual(expected);
  });

  test("an unknown axis, an empty selection and a non-matrix are errors", () => {
    expect(() => {
      return selectCombos(compat, { arch: ["arm"] });
    }).toThrow(/Unknown option --arch/);

    expect(() => {
      return selectCombos(compat, { os: ["windows"] });
    }).toThrow(/No combination/);

    expect(() => {
      return selectCombos(resolveTarget(targets, "greet") as never, {
        os: ["x"],
      });
    }).toThrow(/isn't a matrix/);
  });
});

describe("events", () => {
  test("a pipeline's event names the one pipeline to run", async () => {
    const event = await buildPipelineEvent({
      pipelineId: "pr",
      trigger: "github/pull_request.opened",
      cwd: process.cwd(),
    });

    expect(event.name).toBe("github/pull_request.opened");
    expect(event.data[localTargetKey]).toBe("pr");
  });

  test("a manual event carries the repository and the given data", async () => {
    const event = await buildPipelineEvent({
      pipelineId: "deploy",
      trigger: "ci/manual.deploy",
      data: { environment: "preview" },
      cwd: process.cwd(),
    });

    expect(event.data).toMatchObject({
      environment: "preview",
      [localTargetKey]: "deploy",
    });

    expect(event.data.repository).toBeDefined();
  });

  test("a comment trigger needs its text", async () => {
    await expect(
      buildPipelineEvent({
        pipelineId: "pr",
        trigger: "github/issue_comment.created",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/needs the comment's text/);
  });

  test("a job event names the job, its input and the combinations", async () => {
    const event = await buildJobEvent({
      target: compat,
      input: "jack",
      combos: [{ node: "20", os: "linux" }],
      cwd: process.cwd(),
    });

    expect(event).toMatchObject({
      name: "ci/run-job",
      data: {
        job: "compat",
        input: "jack",
        combos: [{ node: "20", os: "linux" }],
      },
    });
  });
});
