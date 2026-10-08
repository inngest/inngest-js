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
import { from } from "../machine/from.ts";
import { report } from "../report.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { version } from "../version.ts";
import { createCi } from "./createCi.ts";
import { tagStep } from "./metadata.ts";
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

    const test = ci.job("test", async () => {
      await from(install);

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
        commands: 6,
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
      return [update.step, update.values];
    });

    expect(tags).toEqual([
      ["github › check:pr:start", { kind: "check" }],
      ["built › cache:key", { kind: "cache", job: "built" }],
      ["built › cache:lookup", { kind: "cache", job: "built" }],
      ["github › check:built:start", { kind: "check", job: "built" }],
      ["github › check:built:complete", { kind: "check", job: "built" }],
      ["start:plain", { kind: "job", job: "plain" }],
      ["end:plain", { kind: "job", job: "plain" }],
      ["github › check:jobs:complete", { kind: "check" }],
      ["github › check:pr:complete", { kind: "check" }],
    ]);

    for (const update of stepScoped(result.metadata)) {
      expect(update.kind).toBe("userland.inngest-ci");
      expect(update.op).toBe("merge");
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
