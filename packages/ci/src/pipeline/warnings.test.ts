/**
 * Tests of the warning about a parent built just in time: its wording, and
 * that a run says it once, on the parent's lookup row and in its warnings.
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
import { getRunScope } from "./scope.ts";
import { builtJustInTime, warnOnce } from "./warnings.ts";

const refresh = [{ cron: "0 3 * * *" }];
const advice = "add `cache.refresh` to build it ahead of time";

test.each([
  [{ key: "v1" }, advice],
  [{ key: "v1", refresh: [] }, advice],
  [{ key: "v1", refresh }, "not refreshed for these inputs yet"],
])("the wording for %j", (cache, hint) => {
  const { message, line } = builtJustInTime("install", cache);

  expect(line).toBe(`built just in time: \`install\` (${hint})`);
  expect(message).toContain(`(${hint})`);
});

test("a line is added to the run's warnings once", () => {
  const run = { warnings: [] as string[] };

  warnOnce(run, "a");
  warnOnce(run, "a");
  warnOnce(run, "b");

  expect(run.warnings).toEqual(["a", "b"]);
});

describe("a parent built just in time", () => {
  const makeCi = () => {
    return createCi(createCiTestClient(createFakeSandboxApi()), {
      github: consoleReporter(),
      runUrl: ({ runId }) => {
        return `http://localhost:8288/run?runID=${runId}`;
      },
    });
  };

  /** A pipeline of one job that starts from `install`, cached with `cache` if given. */
  const pipelineOf = (cache?: { refresh?: typeof refresh }, flaky = false) => {
    const ci = makeCi();

    const install = ci.job(
      cache ? { id: "install", cache: { key: "v1", ...cache } } : "install",
      async () => {
        await $`pnpm install`;
      },
    );

    const lint = ci.job({ id: "lint", from: install }, async () => {
      await $`pnpm lint`;
    });

    return ci.pipeline(
      { id: "pr", on: prTrigger, ...(flaky ? { retries: 1 as const } : {}) },
      async ({ attempt }) => {
        await lint();

        if (flaky && attempt === 0) {
          throw new Error("flaky infrastructure");
        }

        return getRunScope()?.warnings;
      },
    );
  };

  /** The steps that have an `inngest.warnings` row warning. */
  const warnedSteps = (
    metadata: Awaited<ReturnType<typeof runFunction>>["metadata"],
  ) => {
    return metadata
      .filter((update) => {
        return update.kind === "inngest.warnings";
      })
      .map((update) => {
        return update.step;
      });
  };

  test("a miss is said once on the parent's lookup row and once in the warnings", async () => {
    const result = await runFunction(pipelineOf({}), { event: prEvent });

    expect(warnedSteps(result.metadata)).toEqual(["install (from) › lookup"]);
    expect(result.data).toEqual([
      `built just in time: \`install\` (${advice})`,
    ]);
  });

  test("a replayed handler says it once", async () => {
    const result = await runFunction(pipelineOf({}, true), {
      event: prEvent,
      retries: 1,
    });

    expect(warnedSteps(result.metadata)).toHaveLength(1);
    expect(result.data).toHaveLength(1);
  });

  test("each cached ancestor in a chain is named once, by its own refresh", async () => {
    const ci = makeCi();

    const a = ci.job({ id: "a", cache: { key: "v1", refresh } }, async () => {
      await $`echo a`;
    });

    const b = ci.job({ id: "b", cache: { key: "v1" }, from: a }, async () => {
      await $`echo b`;
    });

    const c = ci.job({ id: "c", from: b }, async () => {
      await $`echo c`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await c();

      return getRunScope()?.warnings;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.data).toEqual([
      "built just in time: `a` (not refreshed for these inputs yet)",
      `built just in time: \`b\` (${advice})`,
    ]);
  });

  test("a hit has no warning", async () => {
    const pipeline = pipelineOf({});

    await runFunction(pipeline, { event: prEvent, runId: "01COLD" });

    const warm = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WARM",
    });

    expect(warnedSteps(warm.metadata)).toEqual([]);
    expect(warm.data).toEqual([]);
  });

  test("a parent with no cache has no warning", async () => {
    const result = await runFunction(pipelineOf(), { event: prEvent });

    expect(warnedSteps(result.metadata)).toEqual([]);
    expect(result.data).toEqual([]);
  });
});
