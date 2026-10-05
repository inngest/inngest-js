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
  type LocalRepo,
  parseCombo,
  pickTrigger,
  resolveTarget,
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
  jobs: [{ id: "lint" }, { id: "test" }],
  matrices: [{ id: "compat", axes: { os: ["linux", "mac"], node: [20, 22] } }],
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
    });
    expect(resolveTarget(manifest, { name: "compat" })).toMatchObject({
      kind: "job",
      axes: { os: ["linux", "mac"], node: [20, 22] },
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

describe("pickTrigger", () => {
  const { triggers } = manifest.pipelines[0] as (typeof manifest.pipelines)[0];

  test("uses the only trigger, or the first interactively", () => {
    expect(
      pickTrigger([{ event: "github/push" }], { interactive: false }),
    ).toBe("github/push");
    expect(pickTrigger(triggers, { interactive: true })).toBe(
      "github/pull_request.opened",
    );
  });

  test("needs --event for several triggers when not interactive", () => {
    expect(() => pickTrigger(triggers, { interactive: false })).toThrow(
      /several triggers/,
    );
  });

  test("matches --event with or without the github/ prefix", () => {
    expect(pickTrigger(triggers, { event: "push", interactive: false })).toBe(
      "github/push",
    );
    expect(() =>
      pickTrigger(triggers, { event: "nope", interactive: false }),
    ).toThrow(/no "nope" trigger/);
  });

  test("rejects crons", () => {
    expect(() =>
      pickTrigger([{ cron: "0 3 * * *" }], { interactive: true }),
    ).toThrow(/Cron/);
  });
});

describe("buildPipelineEvent", () => {
  test("sends --data on a manual trigger, with the repository", async () => {
    const event = await buildPipelineEvent({
      trigger: "ci/manual.deploy",
      data: '{"env":"prod"}',
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
      trigger: "github/push",
      cwd: process.cwd(),
    });

    expect(event.name).toBe("github/push");
    expect(event.data.local).toBeDefined();
  });

  test("a comment trigger needs a body", async () => {
    await expect(
      buildPipelineEvent({
        trigger: "github/issue_comment.created",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/comment's text/);
  });

  test("rejects bad JSON and triggers with no fixture", async () => {
    await expect(
      buildPipelineEvent({
        trigger: "ci/manual.x",
        data: "{",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(
      buildPipelineEvent({
        trigger: "github/merge_group.checks_requested",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow(/no local fixture/);
  });
});

describe("parseCombo", () => {
  const axes = { os: ["linux", "mac"], node: [20, 22] };

  test("is undefined with no flags, to run every combination", () => {
    expect(parseCombo(axes, {})).toBeUndefined();
  });

  test("matches flag text to the axis's own values", () => {
    expect(parseCombo(axes, { os: "mac", node: "22" })).toEqual({
      os: "mac",
      node: 22,
    });
  });

  test("rejects partial, unknown and non-matrix combos", () => {
    expect(() => parseCombo(axes, { os: "mac" })).toThrow(/Missing --node/);
    expect(() => parseCombo(axes, { os: "bsd", node: "20" })).toThrow(
      /isn't a value of os/,
    );
    expect(() =>
      parseCombo(axes, { arch: "x", os: "mac", node: "20" }),
    ).toThrow(/Unknown option --arch/);
    expect(() => parseCombo(undefined, { os: "mac" })).toThrow(
      /isn't a matrix/,
    );
  });
});

describe("buildJobEvent", () => {
  test("carries the repository, input and combo", () => {
    const event = buildJobEvent({
      target: { kind: "job", id: "compat", axes: { os: ["linux"] } },
      repo,
      input: '{"a":1}',
      combo: { os: "linux" },
    });

    expect(event).toEqual({
      name: "ci/run-job",
      data: {
        ...repo.fixtureData,
        job: "compat",
        input: { a: 1 },
        combo: { os: "linux" },
      },
    });
  });
});
