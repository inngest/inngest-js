/**
 * Tests of race parallel mode: every step a pipeline creates carries it, so
 * the executor re-invokes after any of them ends, and a runtime without
 * AsyncLocalStorage falls back with a warning instead of failing.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";
import { inRaceMode } from "./race.ts";
import type { CiRunScope } from "./scope.ts";

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
  const ci = createCi(createCiTestClient(createFakeSandboxApi()), {
    github: consoleReporter(),
  });

  return { ci };
};

describe("race mode", () => {
  test("every step a pipeline run reports carries parallelMode race", async () => {
    const { ci } = setup();

    const build = ci.job("build", async () => {
      await $`pnpm build`;

      await $`pnpm test`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await build();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(result.stepIds.length).toBeGreaterThan(5);

    const missing = result.stepIds.filter((id) => {
      return result.parallelModes[id] !== "race";
    });

    expect(missing).toEqual([]);

    // The background pause and cleanup are among them.
    expect(result.parallelModes["build › pause"]).toBe("race");
  });

  test("a job's next step is reported while a slow sibling's step is pending", async () => {
    const { ci } = setup();

    const fast = ci.job("fast", async () => {
      await $`echo 1`;

      await $`echo 2`;

      await $`echo 3`;
    });

    const slow = ci.job("slow", async () => {
      await $`sleep 100`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await Promise.all([fast(), slow()]);
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    // The harness re-invokes after each race step ends, as the executor does.
    // Without race mode, `fast`'s second command would only be found once
    // `slow`'s first had also finished.
    const batch = result.batches.find((ids) => {
      return (
        ids.some((id) => {
          return id.startsWith("fast") && id.includes("echo 2");
        }) &&
        ids.some((id) => {
          return id.startsWith("slow") && id.includes("sleep 100");
        })
      );
    });

    expect(batch).toBeDefined();
  });

  test("a leaf's pending pause is reported alongside the next job's first step", async () => {
    const { ci } = setup();

    const leaf = ci.job("leaf", async () => {
      await $`pnpm test`;
    });

    const next = ci.job("next", async () => {
      await $`pnpm lint`;

      await $`pnpm format`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await leaf();

        await next();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    const reported = result.batches.some((ids) => {
      return (
        ids.includes("leaf › pause") &&
        ids.includes("github › check:next:start")
      );
    });

    expect(reported).toBe(true);
  });

  test("without AsyncLocalStorage it runs unchanged and warns", async () => {
    const run = { warnings: [] as string[] } as unknown as CiRunScope;

    const ctx = {
      group: {
        parallel: async () => {
          throw new Error("`group.parallel()` requires AsyncLocalStorage");
        },
      },
    };

    const result = await inRaceMode(run, ctx, async () => {
      return "ran";
    });

    expect(result).toBe("ran");
    expect(run.warnings).toHaveLength(1);
  });

  test("an error from the handler isn't mistaken for a missing ALS", async () => {
    const run = { warnings: [] as string[] } as unknown as CiRunScope;

    const ctx = {
      group: {
        parallel: async <T>(
          _options: unknown,
          callback: () => Promise<T>,
        ): Promise<T> => {
          return callback();
        },
      },
    };

    await expect(
      inRaceMode(run, ctx, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(run.warnings).toHaveLength(0);
  });
});
