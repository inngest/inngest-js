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

const refreshTrigger = [{ cron: "0 3 * * *" }];

describe("the warning's wording", () => {
  test("a job without refresh is told to add it", () => {
    const { message, line } = builtJustInTime("install", { key: "v1" });

    expect(message).toContain("Add `cache.refresh` to build it ahead of time.");
    expect(line).toBe(
      "built just in time: `install` (add `cache.refresh` to build it ahead of time)",
    );
  });

  test("a job with refresh is told its triggers hadn't built it", () => {
    const { message, line } = builtJustInTime("install", {
      key: "v1",
      refresh: refreshTrigger,
    });

    expect(message).toContain(
      "Its `cache.refresh` triggers hadn't built a usable snapshot for these inputs yet.",
    );

    expect(line).toBe(
      "built just in time: `install` (not refreshed for these inputs yet)",
    );
  });

  test("an empty refresh list counts as none", () => {
    const { line } = builtJustInTime("install", { key: "v1", refresh: [] });

    expect(line).toContain("add `cache.refresh`");
  });

  test("a line is added to the run's warnings once", () => {
    const run = { warnings: [] as string[] };

    warnOnce(run, "a");
    warnOnce(run, "a");
    warnOnce(run, "b");

    expect(run.warnings).toEqual(["a", "b"]);
  });
});

describe("a parent built just in time", () => {
  const setup = () => {
    const api = createFakeSandboxApi();

    const ci = createCi(createCiTestClient(api), {
      github: consoleReporter(),
      runUrl: ({ runId }) => {
        return `http://localhost:8288/run?runID=${runId}`;
      },
    });

    return { ci };
  };

  /** Two jobs start from `install`, which is cached unless `cache` is false. */
  const pipelineOf = (cache: false | { refresh?: typeof refreshTrigger }) => {
    const { ci } = setup();

    const install = ci.job(
      cache ? { id: "install", cache: { key: "v1", ...cache } } : "install",
      async () => {
        await $`pnpm install`;
      },
    );

    const child = (id: string) => {
      return ci.job({ id, from: install }, async () => {
        await $`echo ${id}`;
      });
    };

    const a = child("a");
    const b = child("b");

    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([a(), b()]);

      return getRunScope()?.warnings;
    });
  };

  /** The `inngest.warnings` metadata, by the step it is on. */
  const rowWarnings = (
    metadata: Awaited<ReturnType<typeof runFunction>>["metadata"],
  ) => {
    return metadata
      .filter((update) => {
        return update.kind === "inngest.warnings";
      })
      .map((update) => {
        return [update.step, update.values] as const;
      });
  };

  test("a miss is said once on the parent's lookup row and once in the warnings", async () => {
    const result = await runFunction(pipelineOf({}), { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(rowWarnings(result.metadata)).toEqual([
      [
        "install (from) › lookup",
        { "ci.justInTime": builtJustInTime("install", { key: "v1" }).message },
      ],
    ]);

    expect(result.data).toEqual([
      builtJustInTime("install", { key: "v1" }).line,
    ]);
  });

  test("a parent with refresh says it wasn't refreshed for these inputs", async () => {
    const result = await runFunction(pipelineOf({ refresh: refreshTrigger }), {
      event: prEvent,
    });

    expect(result.data).toEqual([
      "built just in time: `install` (not refreshed for these inputs yet)",
    ]);
  });

  test("a hit has no warning", async () => {
    const pipeline = pipelineOf({});

    await runFunction(pipeline, { event: prEvent, runId: "01COLD" });

    const warm = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WARM",
    });

    expect(rowWarnings(warm.metadata)).toEqual([]);
    expect(warm.data).toEqual([]);
  });

  test("a parent with no cache has no warning", async () => {
    const result = await runFunction(pipelineOf(false), { event: prEvent });

    expect(rowWarnings(result.metadata)).toEqual([]);
    expect(result.data).toEqual([]);
  });

  test("a replayed handler says it once", async () => {
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

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 1 },
      async ({ attempt }) => {
        await lint();

        if (attempt === 0) {
          throw new Error("flaky infrastructure");
        }

        return getRunScope()?.warnings;
      },
    );

    const result = await runFunction(pipeline, { event: prEvent, retries: 1 });

    expect(result.type).toBe("function-resolved");
    expect(rowWarnings(result.metadata)).toHaveLength(1);
    expect(result.data).toHaveLength(1);
  });

  test("every cached ancestor in a chain is named once", async () => {
    const { ci } = setup();

    const a = ci.job({ id: "a", cache: { key: "v1" } }, async () => {
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

    expect(result.type).toBe("function-resolved");

    expect(result.data).toEqual([
      expect.stringContaining("built just in time: `a`"),
      expect.stringContaining("built just in time: `b`"),
    ]);
  });
});
