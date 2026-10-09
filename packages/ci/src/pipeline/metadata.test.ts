/**
 * Tests of the `userland.inngest-ci` metadata: what a run and its steps are tagged
 * with, that it's sent once however often the handler replays, and that it can
 * never fail a pipeline.
 *
 * @module
 */

import { readFileSync } from "node:fs";
import { runWithAsyncCtx } from "inngest/experimental";
import { describe, expect, test, vi } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { report } from "../report.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { version } from "../version.ts";
import { createCi } from "./createCi.ts";
import { tagStep } from "./metadata.ts";
import { ciOrigin } from "./names.ts";
import type { CiRunScope } from "./scope.ts";
import { getRunScope } from "./scope.ts";

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

type Update = Awaited<ReturnType<typeof runFunction>>["metadata"][number];

const runScoped = (metadata: Update[]) => {
  return metadata.filter((update) => {
    return update.scope === "run";
  });
};

const stepScoped = (metadata: Update[]) => {
  return metadata.filter((update) => {
    return update.scope === "step";
  });
};

describe("run metadata", () => {
  test("a run is tagged at its start and its end", async () => {
    const { ci } = setup();

    const install = ci.job("install", async () => {
      await $`pnpm install`;
    });

    const test = ci.job({ id: "test", from: install }, async () => {
      await $`pnpm test`;
      await $`pnpm lint`;

      await report.summary("hello");
    });

    const compat = ci.matrix(
      { id: "compat", axes: { node: ["20", "22"] } },
      async ({ node }) => {
        await $`pnpm test --node ${node}`;
      },
    );

    const built = ci.job({ id: "built", cache: { key: "v1" } }, async () => {
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([test(), compat(), built()]);
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    const [start, end, ...rest] = runScoped(result.metadata);

    expect(rest).toEqual([]);

    expect(start).toEqual({
      step: "github › check:pr:start",
      kind: "userland.inngest-ci",
      scope: "run",
      op: "merge",
      values: {
        package: "@inngest/ci",
        version,
        local: true,
        repo: "inngest/inngest-js",
        ref: "feature",
        sha: "abc1234",
        pullRequest: 7,
      },
    });

    expect(end?.step).toBe("github › check:pr:complete");
    expect(end?.kind).toBe("userland.inngest-ci");
    expect(end?.op).toBe("merge");

    expect(end?.values).toEqual({
      conclusion: "success",
      jobs: {
        total: 5,
        passed: 5,
        failed: 0,
        cached: 0,
        skipped: 0,
        cancelled: 0,
      },
      apis: {
        from: 1,
        matrix: 1,
        cache: 1,
        sandbox: 0,
        checkout: 0,
        changed: 0,
        report: 1,
        githubRest: 0,
        githubHelpers: 0,
        waitForChecks: 0,
        waitForWorkflow: 0,
        waitFor: 0,
        commands: 4,
        background: 0,
        shard: 0,
        skip: 0,
      },
    });
  });

  test("the end of a failed run says how it failed", async () => {
    const { ci } = setup();

    const lint = ci.job("lint", async () => {
      await $`pnpm lint`.nothrow();

      throw new Error("lint failed");
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 0 },
      async () => {
        await lint();
      },
    );

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-rejected");

    const end = runScoped(result.metadata).find((update) => {
      return "conclusion" in update.values;
    });

    expect(end?.values).toMatchObject({
      conclusion: "failure",
      jobs: { total: 1, passed: 0, failed: 1 },
      apis: { commands: 1 },
    });
  });

  test("a run that is retried is tagged once", async () => {
    const { ci } = setup();

    const test = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: prTrigger, retries: 1 },
      async ({ attempt }) => {
        await test();

        if (attempt === 0) {
          throw new Error("flaky infrastructure");
        }
      },
    );

    const result = await runFunction(pipeline, { event: prEvent, retries: 1 });

    expect(result.type).toBe("function-resolved");

    // The handler ran twice and replayed every step, but a memoized step
    // never runs its callback again, so nothing is sent a second time.
    const keys = result.metadata.map((update) => {
      return `${update.step}:${update.scope}`;
    });

    expect(new Set(keys).size).toBe(keys.length);

    expect(
      runScoped(result.metadata).map((update) => {
        return update.step;
      }),
    ).toEqual(["github › check:pr:start", "github › check:pr:complete"]);
  });

  test("a pipeline with its check off gets one step at each end", async () => {
    const { ci } = setup();

    const test = ci.job({ id: "test", check: false }, async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "nightly", on: { cron: "0 3 * * *" }, check: false },
      async () => {
        await test();
      },
    );

    const result = await runFunction(pipeline, {
      event: { name: "inngest/scheduled.timer", data: {} },
    });

    expect(result.type).toBe("function-resolved");

    const updates = runScoped(result.metadata);

    expect(
      updates.map((update) => {
        return update.step;
      }),
    ).toEqual(["ci › metadata:start", "ci › metadata:end"]);

    expect(updates[0]?.values).toMatchObject({
      local: true,
    });

    expect(updates[0]?.values).not.toHaveProperty("repo");

    expect(updates[1]?.values).toMatchObject({
      conclusion: "success",
    });

    expect(result.stepIds).toContain("ci › metadata:start");
    expect(result.stepIds).toContain("ci › metadata:end");

    expect(result.origins["ci › metadata:start"]).toBe(ciOrigin);
    expect(result.origins["ci › metadata:end"]).toBe(ciOrigin);
  });

  test("a pipeline with its check on adds no steps of its own", async () => {
    const { ci } = setup();

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      return "done";
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(
      result.stepIds.filter((id) => {
        return id.includes("metadata");
      }),
    ).toEqual([]);
  });
});

describe("step metadata", () => {
  test("job, check and cache steps are tagged", async () => {
    const { ci } = setup();

    const built = ci.job({ id: "built", cache: { key: "v1" } }, async () => {
      await $`pnpm build`;
    });

    const plain = ci.job({ id: "plain", check: false }, async () => {});

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await built();
      await plain();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    const tags = stepScoped(result.metadata).map((update) => {
      const { kind, job } = update.values as { kind?: string; job?: string };

      return [
        update.step,
        { ...(kind ? { kind } : {}), ...(job ? { job } : {}) },
      ];
    });

    expect(tags).toEqual([
      ["github › check:pr:start", { kind: "check" }],
      ["built › cache:key", { kind: "cache", job: "built" }],
      ["github › check:built:start", { kind: "check", job: "built" }],
      ["built › lookup", { kind: "cache", job: "built" }],
      ["github › check:built:complete", { kind: "check", job: "built" }],
      ["start:plain", { kind: "job", job: "plain" }],
      ["end:plain", { kind: "job", job: "plain" }],
      ["github › check:jobs:complete", { kind: "check" }],
      ["github › check:pr:complete", { kind: "check" }],
      ["pipeline › cleanup", {}],
      ["pipeline › cleanup:snapshots", {}],
    ]);

    for (const update of stepScoped(result.metadata)) {
      expect(update.kind).toBe("userland.inngest-ci");
      expect(update.op).toBe("merge");
    }

    // Caching, start times and checks are all CI's work, not the jobs'.
    for (const [step] of tags) {
      expect(result.origins[step as string]).toBe(ciOrigin);
    }
  });
});

describe("failing to tag", () => {
  const run = (warn: () => void) => {
    return { ci: { logger: { warn } } } as unknown as CiRunScope;
  };

  const asyncCtx = (addMetadata: () => boolean) => {
    return {
      app: {},
      execution: {
        instance: { addMetadata },
        ctx: {},
        executingStep: { id: "hashed" },
      },
    } as unknown as Parameters<typeof runWithAsyncCtx>[0];
  };

  test("a metadata error is a warning, not a failure", async () => {
    const warn = vi.fn();

    await runWithAsyncCtx(
      asyncCtx(() => {
        throw new Error("nope");
      }),
      async () => {
        await expect(
          tagStep(run(warn), { kind: "job", job: "test" }, { a: 1 }),
        ).resolves.toBeUndefined();
      },
    );

    expect(warn).toHaveBeenCalledOnce();
  });

  test("outside a step there's nothing to tag", async () => {
    const addMetadata = vi.fn(() => {
      return true;
    });

    const ctx = asyncCtx(addMetadata);

    delete (ctx.execution as { executingStep?: unknown }).executingStep;

    await runWithAsyncCtx(ctx, async () => {
      await tagStep(run(vi.fn()), { kind: "job" }, { a: 1 });
    });

    expect(addMetadata).not.toHaveBeenCalled();
  });

  test("the run values and the step values go to the current step", async () => {
    const addMetadata = vi.fn(() => {
      return true;
    });

    await runWithAsyncCtx(asyncCtx(addMetadata), async () => {
      await tagStep(run(vi.fn()), { kind: "job", job: "test" }, { a: 1 });
    });

    expect(addMetadata.mock.calls).toEqual([
      ["hashed", "userland.inngest-ci", "run", "merge", { a: 1 }],
      [
        "hashed",
        "userland.inngest-ci",
        "step",
        "merge",
        { kind: "job", job: "test" },
      ],
    ]);
  });
});

describe("pieces", () => {
  test("the generated version is the package's version", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(version).toBe(pkg.version);
  });
});

describe("the just-in-time warning", () => {
  const pipelineOf = (parent: false | { warm?: boolean }) => {
    const { ci } = setup();

    const install = ci.job(
      parent
        ? {
            id: "install",
            cache: {
              key: "v1",
              ...(parent.warm ? { warm: [{ cron: "0 3 * * *" }] } : {}),
            },
          }
        : { id: "install" },
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

  const warned = (metadata: Update[]) => {
    return metadata
      .filter((update) => {
        return update.kind === "inngest.warnings";
      })
      .map((update) => {
        return [update.step, update.values] as const;
      })
      .sort(([left], [right]) => {
        return left.localeCompare(right);
      });
  };

  const unwarmed =
    "`install` had no usable cached snapshot for these inputs, so it was built while the jobs that start from it waited. Add `cache.warm` to build it ahead of time.";

  const warmed =
    "`install` had no usable cached snapshot for these inputs, so it was built while the jobs that start from it waited. Its `cache.warm` triggers hadn't built a usable snapshot for these inputs yet.";

  test("a miss on a parent without warm advises cache.warm, on the parent's one lookup row and once in the warnings", async () => {
    const result = await runFunction(pipelineOf({}), { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(warned(result.metadata)).toEqual([
      ["install (from) › lookup", { "ci.justInTime": unwarmed }],
    ]);

    expect(result.data).toEqual([
      "built just in time: `install` (add `cache.warm` to build it ahead of time)",
    ]);
  });

  test("a miss on a parent with warm says it wasn't warmed for these inputs", async () => {
    const result = await runFunction(pipelineOf({ warm: true }), {
      event: prEvent,
    });

    expect(result.type).toBe("function-resolved");

    expect(warned(result.metadata)).toEqual([
      ["install (from) › lookup", { "ci.justInTime": warmed }],
    ]);

    expect(result.data).toEqual([
      "built just in time: `install` (not warmed for these inputs yet)",
    ]);
  });

  test("a hit has no warning", async () => {
    const pipeline = pipelineOf({});

    await runFunction(pipeline, { event: prEvent, runId: "01COLD" });

    const warm = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WARM",
    });

    expect(warned(warm.metadata)).toEqual([]);
    expect(warm.data).toEqual([]);
  });

  test("an uncached parent has no warning", async () => {
    const result = await runFunction(pipelineOf(false), { event: prEvent });

    expect(warned(result.metadata)).toEqual([]);
    expect(result.data).toEqual([]);
  });

  test("a replayed handler sends each warning once", async () => {
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

    expect(warned(result.metadata)).toEqual([
      ["install (from) › lookup", { "ci.justInTime": unwarmed }],
    ]);

    expect(result.data).toEqual([
      "built just in time: `install` (add `cache.warm` to build it ahead of time)",
    ]);
  });

  test("a cold ancestor in a chain is warned about once, with no row to carry it", async () => {
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

    const cold = await runFunction(pipeline, { event: prEvent, runId: "01A" });

    expect(cold.type).toBe("function-resolved");

    expect(cold.data).toEqual([
      expect.stringContaining("built just in time: `a`"),
      expect.stringContaining("built just in time: `b`"),
    ]);
  });
});

describe("the uncached-base warning", () => {
  const warned = (metadata: Update[]) => {
    return metadata
      .filter((update) => {
        return update.kind === "inngest.warnings";
      })
      .map((update) => {
        return [update.step, update.values] as const;
      });
  };

  const message = (jobId: string, baseId: string) => {
    return `\`${jobId}\` is cached, but it starts from \`${baseId}\`, which has no \`cache\`. \`${baseId}\` is built fresh in every run, so \`${jobId}\` is rebuilt in every run too and its snapshot is never reused or named. Give \`${baseId}\` a \`cache\`.`;
  };

  const line = (jobId: string, baseId: string) => {
    return `never reused: \`${jobId}\` starts from \`${baseId}\`, which has no \`cache\` (give \`${baseId}\` a \`cache\`)`;
  };

  test("a cached job on an uncached parent says so on the parent's lookup row and in the warnings, every run", async () => {
    const { api, ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const build = ci.job(
      { id: "build", from: base, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await build();

      return getRunScope()?.warnings;
    });

    for (const runId of ["01A", "01B"]) {
      const result = await runFunction(pipeline, { event: prEvent, runId });

      expect(result.type).toBe("function-resolved");

      expect(warned(result.metadata)).toEqual([
        [
          "base (from) › lookup",
          { "ci.uncachedBase": message("build", "base") },
        ],
      ]);

      expect(result.data).toEqual([line("build", "base")]);
    }

    const builds = api.commands.filter((argv) => {
      return argv.join(" ").includes("pnpm build");
    });

    expect(builds).toHaveLength(2);
  });

  test("a cached parent on an uncached base says so instead of suggesting warm", async () => {
    const { ci } = setup();

    const base = ci.job("base", async () => {
      await $`pnpm install`;
    });

    const build = ci.job(
      { id: "build", from: base, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;
      },
    );

    const test = ci.job({ id: "test", from: build }, async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();

      return getRunScope()?.warnings;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(warned(result.metadata)).toEqual([
      [
        "build (from) › lookup",
        { "ci.uncachedBase": message("build", "base") },
      ],
    ]);

    expect(result.data).toEqual([line("build", "base")]);
  });

  test("every cached job below an uncached one names it, and none suggests warm", async () => {
    const { ci } = setup();

    const a = ci.job("a", async () => {
      await $`echo a`;
    });

    const b = ci.job({ id: "b", from: a, cache: { key: "v1" } }, async () => {
      await $`echo b`;
    });

    const c = ci.job({ id: "c", from: b, cache: { key: "v1" } }, async () => {
      await $`echo c`;
    });

    const d = ci.job({ id: "d", from: c }, async () => {
      await $`echo d`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await d();

      return getRunScope()?.warnings;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect([...(result.data as string[])].sort()).toEqual(
      [line("b", "a"), line("c", "a")].sort(),
    );
  });

  test("a cached job on a cached parent has no such warning", async () => {
    const { ci } = setup();

    const base = ci.job({ id: "base", cache: { key: "v1" } }, async () => {
      await $`pnpm install`;
    });

    const build = ci.job(
      { id: "build", from: base, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;
      },
    );

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await build();

      return getRunScope()?.warnings;
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(
      warned(result.metadata).filter(([, values]) => {
        return "ci.uncachedBase" in values;
      }),
    ).toEqual([]);

    expect(result.data).not.toContainEqual(
      expect.stringContaining("never reused"),
    );
  });
});
