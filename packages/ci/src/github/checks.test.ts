/**
 * Tests for check reporting (check runs, statuses, console), the GitHub
 * skip/permission flows, and the deprecation markers on unsupported APIs.
 *
 * @module
 */

import { describe, expect, test } from "vitest";

import { $ } from "../machine/command.ts";
import { createCi } from "../pipeline/createCi.ts";
import { type CiRunScope, getRunScope } from "../pipeline/scope.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeGitHub } from "../testing/fakeGitHub.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { consoleReporter, githubToken } from "./auth.ts";
import {
  checksSink,
  createCheckReporter,
  normaliseAnnotation,
  pipelineSummary,
  statusesSink,
  truncateSummary,
} from "./checks.ts";

const fakeRun = (overrides: Partial<CiRunScope> = {}): CiRunScope => {
  return {
    runId: "01TESTRUN",
    functionId: "pr",
    pipelineId: "pr",
    checkName: "pr",
    jobChecks: true,
    event: { name: "github/pull_request.opened" },
    repo: {
      owner: "inngest",
      name: "inngest-js",
      fullName: "inngest/inngest-js",
      sha: "abc1234",
    },
    jobs: new Map(),
    jobCalls: new Map(),
    machines: new Map(),
    snapshots: new Map(),
    cached: new Map(),
    createdSnapshots: new Set(),
    sandboxes: new Set(),
    summaries: [],
    counters: new Map(),
    warnings: [],
    pipelineSummaries: [],
    pipelineAnnotations: [],
    ci: {
      runUrl: ({ runId }: { runId: string }) => {
        return `http://trace/${runId}`;
      },
    },
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: a partial scope is enough here
  } as any;
};

describe("check idempotency", () => {
  test("a retried create reuses the check run it already made", async () => {
    const gh = createFakeGitHub();

    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
      check_runs: [{ id: 55, external_id: "01TESTRUN:pipeline", name: "pr" }],
    });

    const sink = checksSink(
      githubToken({
        token: "t",
        baseUrl: "https://api.github.test",
        fetch: gh.fetch,
      }),
    );

    const result = await sink.start({
      run: fakeRun(),
      name: "pr",
      externalId: "01TESTRUN:pipeline",
      detailsUrl: "http://trace/01TESTRUN",
    });

    expect(result).toEqual({ id: 55 });

    expect(
      gh.requests.filter((request) => {
        return request.method === "POST";
      }),
    ).toHaveLength(0);
  });

  test("with no matching check run, one is created", async () => {
    const gh = createFakeGitHub();

    gh.route("GET /repos/inngest/inngest-js/commits/abc1234/check-runs", {
      check_runs: [{ id: 1, external_id: "someone-else", name: "pr" }],
    });

    gh.route("POST /repos/inngest/inngest-js/check-runs", { id: 77 });

    const sink = checksSink(
      githubToken({
        token: "t",
        baseUrl: "https://api.github.test",
        fetch: gh.fetch,
      }),
    );

    const result = await sink.start({
      run: fakeRun(),
      name: "pr",
      externalId: "01TESTRUN:pipeline",
      detailsUrl: "http://trace/01TESTRUN",
    });

    expect(result).toEqual({ id: 77 });
  });

  test("annotations past the first batch go up as further updates", async () => {
    const gh = createFakeGitHub();

    gh.route("PATCH /repos/inngest/inngest-js/check-runs/55", { id: 55 });

    const sink = checksSink(
      githubToken({
        token: "t",
        baseUrl: "https://api.github.test",
        fetch: gh.fetch,
      }),
    );

    await sink.complete({
      run: fakeRun(),
      name: "pr / test",
      externalId: "01TESTRUN:test",
      detailsUrl: "http://trace/01TESTRUN",
      conclusion: "failure",
      title: "failed",
      summary: "…",
      annotations: Array.from({ length: 120 }, (_, index) => {
        return normaliseAnnotation({
          path: "app/src/sum.ts",
          line: index + 1,
          message: "boom",
        });
      }),
      checkRunId: 55,
    });

    const updates = gh.requests.filter((request) => {
      return request.method === "PATCH";
    });

    expect(updates).toHaveLength(3);

    expect(
      updates.map((request) => {
        return (request.body as { output: { annotations: unknown[] } }).output
          .annotations.length;
      }),
    ).toEqual([50, 50, 20]);
  });
});

describe("commit statuses", () => {
  test("conclusions map onto the four status states", async () => {
    const gh = createFakeGitHub();

    gh.route("POST /repos/inngest/inngest-js/statuses/abc1234", {});

    const sink = statusesSink(
      githubToken({
        token: "t",
        baseUrl: "https://api.github.test",
        fetch: gh.fetch,
      }),
    );

    const run = fakeRun();

    for (const conclusion of ["success", "failure", "cancelled"] as const) {
      await sink.complete({
        run,
        name: "pr",
        externalId: "01TESTRUN:pipeline",
        detailsUrl: "http://trace/01TESTRUN",
        conclusion,
        title: `${conclusion} title`,
        summary: "",
        annotations: [],
      });
    }

    expect(
      gh.requests.map((request) => {
        return (request.body as { state: string }).state;
      }),
    ).toEqual(["success", "failure", "error"]);
  });
});

describe("attempt reporting", () => {
  test("a retry updates the job check with the attempt and the error", async () => {
    const updates: Array<{ name: string; title: string }> = [];

    const reporter = createCheckReporter({
      start: async () => {
        return { id: 1 };
      },
      complete: async () => {
        return undefined;
      },
      update: async ({ name, title }) => {
        updates.push({ name, title });
      },
    });

    const run = fakeRun({
      step: {
        run: (async (_id: unknown, fn: () => unknown) => {
          return fn();
          // biome-ignore lint/suspicious/noExplicitAny: a stub step tool
        }) as any,
        // biome-ignore lint/suspicious/noExplicitAny: a stub step tool
      } as any,
    });

    await reporter.commandRetry({
      run,
      jobPath: "test",
      attempt: 1,
      of: 2,
      error: new Error("`pnpm test` exited with 1\nsecond line"),
    });

    expect(updates).toEqual([
      { name: "pr / test", title: "Attempt 1 of 2: `pnpm test` exited with 1" },
    ]);
  });
});

describe("summary truncation", () => {
  test("multi-byte text is cut by UTF-8 bytes without splitting a character", () => {
    const summary = truncateSummary("€".repeat(30_000));

    expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(65_535);
    expect(summary).not.toContain("�");
    expect(summary).toContain("truncated");
  });
});

describe("live updates", () => {
  test("an in-progress update keeps the summary the check already has", async () => {
    const gh = createFakeGitHub();

    gh.route("GET /repos/inngest/inngest-js/check-runs/55", {
      id: 55,
      output: { title: "old", summary: "the existing summary" },
    });

    gh.route("PATCH /repos/inngest/inngest-js/check-runs/55", { id: 55 });

    const sink = checksSink(
      githubToken({
        token: "t",
        baseUrl: "https://api.github.test",
        fetch: gh.fetch,
      }),
    );

    await sink.update?.({
      run: fakeRun(),
      name: "pr / test",
      title: "Running `pnpm test`",
      checkRunId: 55,
    });

    const patch = gh.requests.find((request) => {
      return request.method === "PATCH";
    });

    expect(patch?.body).toMatchObject({
      output: {
        title: "Running `pnpm test`",
        summary: "the existing summary",
      },
    });
  });
});

describe("pipeline summary", () => {
  test("lists jobs, links the trace, and names kept machines", () => {
    const summary = pipelineSummary(
      fakeRun({
        summaries: [
          {
            path: "setup",
            conclusion: "success",
            title: "Cached 5h ago",
            durationMs: 0,
            cached: true,
          },
          {
            path: "test",
            conclusion: "failure",
            title: "`pnpm test` exited with 1",
            durationMs: 65_000,
            keptSnapshotId: "snap-1",
          },
        ],
        warnings: ["fell back: snapshots unavailable"],
      }),
    );

    expect(summary).toContain("| setup | success | Cached 5h ago |");
    expect(summary).toContain("| test | failure |");
    expect(summary).toContain("1m 05s");
    expect(summary).toContain("[View the trace](http://trace/01TESTRUN)");
    expect(summary).toContain("kept as snapshot `snap-1`");
    expect(summary).toContain("fell back: snapshots unavailable");
  });
});

describe("a required check never hangs", () => {
  test("the pipeline check completes even when a job throws", async () => {
    const api = createFakeSandboxApi();
    const client = createCiTestClient(api);
    const reporter = consoleReporter();
    const ci = createCi(client, { github: reporter });

    const job = ci.job("boom", async () => {
      throw new Error("something went wrong in the app's code");
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: [{ event: "test/event" }], retries: 0 },
      async () => {
        return job();
      },
    );

    const result = await runFunction(pipeline);

    expect(result.type).toBe("function-rejected");

    const pipelineCheck = reporter.history.filter((entry) => {
      return entry.name === "pr" && entry.status === "completed";
    });

    expect(pipelineCheck).toHaveLength(1);
    expect(pipelineCheck[0]?.conclusion).toBe("failure");
    expect(pipelineCheck[0]?.title).toContain("something went wrong");
  });

  test("a settled failed job still fails the pipeline", async () => {
    const api = createFakeSandboxApi();
    const client = createCiTestClient(api);
    const reporter = consoleReporter();
    const ci = createCi(client, { github: reporter });

    api.script([{ match: "pnpm test", exitCode: 1 }]);

    const failing = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const passing = ci.job("lint", async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: [{ event: "test/event" }] },
      async () => {
        await Promise.allSettled([failing(), passing()]);
      },
    );

    const result = await runFunction(pipeline);

    expect(result.type).toBe("function-rejected");

    const completed = (name: string) => {
      return reporter.history.find((entry) => {
        return entry.name === name && entry.status === "completed";
      });
    };

    expect(completed("pr / lint")?.conclusion).toBe("success");
    expect(completed("pr / test")?.conclusion).toBe("failure");
    expect(completed("pr")?.conclusion).toBe("failure");
  });

  test("jobs still running when the run fails are cancelled in one step", async () => {
    const api = createFakeSandboxApi();
    const client = createCiTestClient(api);
    const reporter = consoleReporter();
    const ci = createCi(client, { github: reporter });

    api.script([
      { match: "pnpm test", exitCode: 1 },
      { match: "pnpm build", ticks: 50 },
    ]);

    const failing = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const slow = ci.job("slow", async () => {
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: [{ event: "test/event" }] },
      async () => {
        await Promise.all([failing(), slow()]);
      },
    );

    const result = await runFunction(pipeline);

    expect(result.type).toBe("function-rejected");

    // One step whatever was open, so no request can ask for a per-job step
    // that a later request, with its siblings further along, wouldn't reach.
    expect(
      result.stepIds.filter((id) => {
        return id === "github › check:jobs:complete";
      }),
    ).toHaveLength(1);

    expect(result.stepIds).not.toContain("github › check:slow:complete");

    const slowCheck = reporter.history.find((entry) => {
      return entry.name === "pr / slow" && entry.status === "completed";
    });

    expect(slowCheck?.conclusion).toBe("cancelled");
  });

  test("a job that passed is no longer open while its check completes", async () => {
    const api = createFakeSandboxApi();
    const client = createCiTestClient(api);
    const ci = createCi(client, { github: consoleReporter() });
    const openWhenCompleting: boolean[] = [];

    const job = ci.job("test", async () => {
      await $`pnpm test`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: [{ event: "test/event" }] },
      async () => {
        const run = getRunScope();

        if (run) {
          const tools = run.step;

          run.step = new Proxy(tools, {
            get: (target, key) => {
              if (key !== "run") {
                return Reflect.get(target, key);
              }

              // biome-ignore lint/suspicious/noExplicitAny: passing through
              return (step: { id: string }, ...rest: any[]) => {
                if (step.id === "github › check:test:complete") {
                  openWhenCompleting.push(run.openChecks.has("test"));
                }

                // biome-ignore lint/suspicious/noExplicitAny: passing through
                return (target.run as any)(step, ...rest);
              };
            },
          });
        }

        await job();
      },
    );

    await runFunction(pipeline);

    // A sibling failing while the step is in flight would otherwise cancel a
    // job that passed.
    expect(openWhenCompleting.length).toBeGreaterThan(0);
    expect(openWhenCompleting).not.toContain(true);
  });

  test("checks held back for a retry are kept in progress in one step", async () => {
    const api = createFakeSandboxApi();
    const client = createCiTestClient(api);
    const reporter = consoleReporter();
    const ci = createCi(client, { github: reporter });

    api.script([{ match: "pnpm build", ticks: 50 }]);

    const failing = ci.job("test", async () => {
      throw new Error("flaky infrastructure");
    });

    const slow = ci.job("slow", async () => {
      await $`pnpm build`;
    });

    const pipeline = ci.pipeline(
      { id: "pr", on: [{ event: "test/event" }], retries: 1 },
      async () => {
        await Promise.all([failing(), slow()]);
      },
    );

    const result = await runFunction(pipeline, { retries: 1 });

    // One step per attempt whatever was held back, so no request can ask for
    // a per-job step that a later request wouldn't reach.
    expect(
      result.stepIds.filter((id) => {
        return id.startsWith("github › check:jobs:retry:");
      }),
    ).toEqual(["github › check:jobs:retry:0"]);

    expect(result.stepIds).not.toContain("github › check:test:retry:0");
  });
});

describe("dev mode", () => {
  test("checks stay in the console even with a GitHub provider", async () => {
    const gh = createFakeGitHub();
    // The test client is in dev mode, as it is against the Dev Server.
    const client = createCiTestClient(createFakeSandboxApi());

    const ci = createCi(client, {
      github: githubToken({
        token: "t",
        baseUrl: "https://api.github.test",
        fetch: gh.fetch,
      }),
    });

    const job = ci.job("build", async () => {});

    const pipeline = ci.pipeline(
      { id: "pr", on: [{ event: "github/pull_request.opened" }] },
      async () => {
        await job();
      },
    );

    const result = await runFunction(pipeline, {
      event: {
        name: "github/pull_request.opened",
        data: {
          action: "opened",
          number: 7,
          repository: { full_name: "inngest/inngest-js" },
          pull_request: {
            number: 7,
            head: { sha: "abc1234", ref: "feature" },
            base: { sha: "def5678", ref: "main" },
          },
        },
      },
    });

    expect(result.type).toBe("function-resolved");
    // Nothing reaches GitHub: no check runs, and no commit statuses either.
    expect(gh.requests).toEqual([]);
  });
});

describe("check run IDs across runs", () => {
  test("two runs of one pipeline each complete their own check", async () => {
    const completed: Array<{ runId: string; checkRunId?: number }> = [];
    let next = 100;

    const reporter = createCheckReporter({
      start: async () => {
        next += 1;

        return { id: next };
      },
      complete: async ({ run, checkRunId }) => {
        completed.push({ runId: run.runId, checkRunId });
      },
    });

    const step = {
      run: (async (_id: unknown, fn: () => unknown) => {
        return fn();
        // biome-ignore lint/suspicious/noExplicitAny: a stub step tool
      }) as any,
      // biome-ignore lint/suspicious/noExplicitAny: a stub step tool
    } as any;

    const runA = fakeRun({ runId: "A", step });
    const runB = fakeRun({ runId: "B", step });

    await reporter.pipelineStart({ run: runA });
    await reporter.pipelineStart({ run: runB });

    await reporter.pipelineComplete({
      run: runA,
      conclusion: "success",
      title: "ok",
    });

    await reporter.pipelineComplete({
      run: runB,
      conclusion: "success",
      title: "ok",
    });

    expect(completed).toEqual([
      { runId: "A", checkRunId: 101 },
      { runId: "B", checkRunId: 102 },
    ]);
  });
});
