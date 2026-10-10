/**
 * Tests of the `intent` and `outcome` every step CI generates carries in its
 * `userland.inngest-ci` step metadata: a sentence written for what the step
 * set out to do, and a small object for what happened.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";
import { ciStepOptions, metadataKind } from "./metadata.ts";
import { ciOrigin, type StepSpec, steps } from "./names.ts";

const setup = () => {
  const ci = createCi(createCiTestClient(createFakeSandboxApi()), {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  const install = ci.job({ id: "install", cache: { key: "v1" } }, async () => {
    await $`pnpm install`;
  });

  const lint = ci.job({ id: "lint", from: install }, async () => {
    await $`pnpm lint`;
  });

  const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
    await lint();
  });

  return pipeline;
};

type Metadata = Awaited<ReturnType<typeof runFunction>>["metadata"];

/** A step's own metadata values, by the step's ID. */
const stepValues = (metadata: Metadata, step: string) => {
  return metadata
    .filter((update) => {
      return (
        update.step === step &&
        update.scope === "step" &&
        update.kind === metadataKind
      );
    })
    .map((update) => {
      return update.values;
    });
};

describe("intent and outcome in a run", () => {
  test("each step says what it set out to do and what happened, once", async () => {
    const pipeline = setup();

    const first = await runFunction(pipeline, { event: prEvent });
    const second = await runFunction(pipeline, {
      event: prEvent,
      runId: "01SECOND",
    });

    const expected: Array<[Metadata, string, Record<string, unknown>]> = [
      [
        first.metadata,
        "install (from) › lookup",
        {
          kind: "cache",
          job: "install",
          intent: "Look up the cached snapshot for `install`",
          outcome: { found: false },
        },
      ],
      [
        second.metadata,
        "install (from) › lookup",
        {
          intent: "Look up the cached snapshot for `install`",
          outcome: { found: true, snapshotId: expect.any(String) },
        },
      ],
      [
        first.metadata,
        "github › check:pr:start",
        { kind: "check", intent: "Start the check `pr`" },
      ],
      [
        first.metadata,
        "github › check:pr:complete",
        {
          kind: "check",
          intent: "Report `pr`'s check",
          outcome: { conclusion: "success", annotations: 0 },
        },
      ],
      [
        first.metadata,
        "pipeline › cleanup",
        {
          intent: "Destroy this run's sandboxes",
          outcome: { destroyed: expect.any(Number) },
        },
      ],
      [
        first.metadata,
        "pipeline › cleanup:snapshots",
        {
          intent: "Delete the snapshots this run took",
          outcome: { deleted: expect.any(Number), failed: 0 },
        },
      ],
    ];

    for (const [metadata, step, values] of expected) {
      const sent = stepValues(metadata, step);

      expect(sent, step).toHaveLength(1);
      expect(sent[0], step).toMatchObject(values);
    }
  });
});

describe("ciStepOptions", () => {
  const valuesOf = <T>(
    spec: StepSpec<T>,
    result: { data?: unknown; error?: unknown },
  ) => {
    const { values } = ciStepOptions(spec).metadata ?? {};

    return typeof values === "function" ? values(result as never) : values;
  };

  test("takes the outcome from what the step returned", () => {
    expect(
      valuesOf(steps.checkSnapshotState("id", "snap-1"), { data: "ready" }),
    ).toEqual({
      intent: "Check the state of snapshot `snap-1`",
      outcome: { snapshotId: "snap-1", state: "ready" },
    });
  });

  test("keeps the tag, the intent and a static outcome when the step throws", () => {
    expect(
      valuesOf(steps.recordCommandFailure("test", 2), {
        error: new Error("exit 2\nsecond line"),
      }),
    ).toEqual({
      intent: "Record that the command failed",
      outcome: { exitCode: 2, error: "exit 2" },
    });

    expect(
      valuesOf(steps.cacheKey("test", "test"), { error: new Error("nope") }),
    ).toEqual({
      kind: "cache",
      job: "test",
      intent: "Work out the cache key for `test`",
      outcome: { error: "nope" },
    });
  });

  test("cuts long outcome strings and lists", () => {
    const { outcome } = valuesOf(
      {
        id: "id",
        name: "Name",
        intent: "Do the thing",
        outcome: {
          text: "x".repeat(500),
          list: Array.from({ length: 30 }, (_, i) => {
            return i;
          }),
        },
      },
      { data: undefined },
    ) as { outcome: { text: string; list: number[] } };

    expect(outcome.text).toHaveLength(200);
    expect(outcome.list).toHaveLength(10);
  });

  test("marks CI's own steps with its origin, and steps you called without", () => {
    expect(ciStepOptions(steps.cleanUpMachines(0))).toMatchObject({
      "~origin": ciOrigin,
    });

    expect(ciStepOptions(steps.findChangedFiles())).not.toHaveProperty(
      "~origin",
    );
  });
});
