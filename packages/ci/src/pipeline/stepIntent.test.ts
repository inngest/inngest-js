/**
 * Tests of the `intent` and `outcome` every step CI generates carries in its
 * `userland.inngest-ci` step metadata: a sentence written for what the step
 * set out to do, and a small object for what happened.
 *
 * @module
 */

import { runWithAsyncCtx } from "inngest/experimental";
import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";
import { withNotes } from "./metadata.ts";

const prEvent = {
  name: "github/pull_request.opened",
  data: {
    action: "opened",
    number: 7,
    repository: { full_name: "inngest/inngest-js" },
    pull_request: {
      number: 7,
      head: {
        sha: "abc1234",
        ref: "feature",
        repo: { full_name: "inngest/inngest-js" },
      },
      base: { sha: "def5678", ref: "main" },
    },
    _github: { event: "pull_request", installationId: 1 },
  },
};

const prTrigger = [{ event: "github/pull_request.opened" }];

const setup = () => {
  const api = createFakeSandboxApi();
  const client = createCiTestClient(api);

  const ci = createCi(client, {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  return { api, client, ci };
};

type Metadata = Awaited<ReturnType<typeof runFunction>>["metadata"];

/** A step's own metadata values, by the step's ID. */
const stepValues = (metadata: Metadata, step: string) => {
  return metadata.find((update) => {
    return (
      update.step === step &&
      update.scope === "step" &&
      update.kind !== "inngest.warnings"
    );
  })?.values;
};

describe("intent and outcome", () => {
  test("a cache lookup says whether it found a snapshot", async () => {
    const { ci } = setup();

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const lint = ci.job({ id: "lint", from: install }, async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    const first = await runFunction(pipeline, { event: prEvent });

    expect(first.type).toBe("function-resolved");

    const miss = stepValues(first.metadata, "lint › from install");

    expect(miss).toMatchObject({
      kind: "cache",
      job: "lint",
      intent: "Look up the snapshot of `install` to start from",
      outcome: { found: false },
    });
  });

  test("a check's steps say what they reported", async () => {
    const { ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return "done";
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(
      stepValues(result.metadata, "github › check:pr:start"),
    ).toMatchObject({
      kind: "check",
      intent: "Start the check `pr`",
      outcome: {},
    });

    expect(
      stepValues(result.metadata, "github › check:pr:complete"),
    ).toMatchObject({
      kind: "check",
      intent: "Report `pr`'s check as passed",
      outcome: { conclusion: "success", annotations: 0 },
    });
  });

  test("cleanup says what it destroyed", async () => {
    const { ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await ci.job("test", async () => {
        await $`pnpm test`;
      })();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(stepValues(result.metadata, "pipeline › cleanup")).toEqual({
      intent: "Destroy this run's sandboxes",
      outcome: { destroyed: 1 },
    });

    expect(
      stepValues(result.metadata, "pipeline › cleanup:snapshots"),
    ).toMatchObject({
      intent: "Delete the snapshots this run took",
      outcome: { deleted: 0, failed: 0 },
    });
  });

  test("a lookup that finds a snapshot says which", async () => {
    const { ci } = setup();

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const lint = ci.job({ id: "lint", from: install }, async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    await runFunction(pipeline, { event: prEvent, runId: "01FIRST" });

    const second = await runFunction(pipeline, {
      event: prEvent,
      runId: "01SECOND",
    });

    const hit = stepValues(second.metadata, "lint › from install");

    expect(hit).toMatchObject({
      intent: "Look up the snapshot of `install` to start from",
      outcome: { found: true, snapshotId: expect.any(String) },
    });
  });
});

describe("a step that fails", () => {
  const asyncCtx = (addMetadata: (...args: unknown[]) => boolean) => {
    return {
      app: {},
      execution: {
        instance: { addMetadata },
        ctx: {},
        executingStep: { id: "hashed" },
      },
    } as unknown as Parameters<typeof runWithAsyncCtx>[0];
  };

  test("keeps its intent and records the error's first line", async () => {
    const updates: unknown[][] = [];

    await runWithAsyncCtx(
      asyncCtx((...args) => {
        updates.push(args);

        return true;
      }),
      async () => {
        await expect(
          withNotes({ ci: {} }, { intent: "Do the thing" }, async (note) => {
            note.outcome({ attempted: true });

            throw new Error(`nope\nsecond line`);
          }),
        ).rejects.toThrow("nope");
      },
    );

    expect(updates).toEqual([
      [
        "hashed",
        "userland.inngest-ci",
        "step",
        "merge",
        {
          intent: "Do the thing",
          outcome: { attempted: true, error: "nope" },
        },
      ],
    ]);
  });

  test("long outcome strings and lists are cut", async () => {
    const updates: unknown[][] = [];

    await runWithAsyncCtx(
      asyncCtx((...args) => {
        updates.push(args);

        return true;
      }),
      async () => {
        await withNotes({ ci: {} }, { intent: "Do the thing" }, (note) => {
          note.outcome({
            text: "x".repeat(500),
            list: Array.from({ length: 30 }, (_, i) => {
              return i;
            }),
          });
        });
      },
    );

    const outcome = (updates[0]?.[4] as { outcome: Record<string, unknown> })
      .outcome;

    expect((outcome.text as string).length).toBe(200);
    expect(outcome.list).toHaveLength(10);
  });
});
