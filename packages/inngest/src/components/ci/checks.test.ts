import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { createCi } from "./createCi.ts";
import { consoleReporter, githubToken } from "./github/auth.ts";
import {
  checksSink,
  createCheckReporter,
  normaliseAnnotation,
  pipelineSummary,
  resetTitleThrottle,
  statusesSink,
} from "./github/checks.ts";
import type { CiRunScope } from "./scope.ts";
import {
  createCiTestClient,
  createFakeGitHub,
  createFakeSandboxApi,
  runFunction,
} from "./testHelpers.ts";

const fakeRun = (overrides: Partial<CiRunScope> = {}): CiRunScope =>
  ({
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
    machines: new Map(),
    snapshots: new Map(),
    cacheEntries: new Map(),
    sandboxes: new Set(),
    summaries: [],
    counters: new Map(),
    snapshotsUnavailable: false,
    warnings: [],
    pipelineSummaries: [],
    pipelineAnnotations: [],
    ci: {
      runUrl: ({ runId }: { runId: string }) => `http://trace/${runId}`,
    },
    ...overrides,
    // biome-ignore lint/suspicious/noExplicitAny: a partial scope is enough here
  }) as any;

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
      gh.requests.filter((request) => request.method === "POST"),
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
      annotations: Array.from({ length: 120 }, (_, index) =>
        normaliseAnnotation({
          path: "app/src/sum.ts",
          line: index + 1,
          message: "boom",
        }),
      ),
      checkRunId: 55,
    });

    const updates = gh.requests.filter((request) => request.method === "PATCH");

    expect(updates).toHaveLength(3);
    expect(
      updates.map(
        (request) =>
          (request.body as { output: { annotations: unknown[] } }).output
            .annotations.length,
      ),
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
      gh.requests.map((request) => (request.body as { state: string }).state),
    ).toEqual(["success", "failure", "error"]);
  });
});

describe("attempt reporting", () => {
  test("a retry updates the job check with the attempt and the error", async () => {
    resetTitleThrottle();

    const updates: Array<{ name: string; title: string }> = [];

    const reporter = createCheckReporter({
      start: async () => ({ id: 1 }),
      complete: async () => undefined,
      update: async ({ name, title }) => {
        updates.push({ name, title });
      },
    });

    const run = fakeRun({
      step: {
        // biome-ignore lint/suspicious/noExplicitAny: a stub step tool
        run: (async (_id: unknown, fn: () => unknown) => fn()) as any,
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

describe("pipeline summary", () => {
  test("lists jobs, links the trace, and names kept machines", () => {
    const summary = pipelineSummary(
      fakeRun({
        summaries: [
          {
            path: "setup",
            conclusion: "success",
            title: "Restored, built 5h ago",
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

    expect(summary).toContain("| setup | success | Restored, built 5h ago |");
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
      { id: "pr", on: [{ event: "test/event" }] },
      async () => job(),
    );

    const result = await runFunction(pipeline);

    expect(result.type).toBe("function-rejected");

    const pipelineCheck = reporter.history.filter(
      (entry) => entry.name === "pr" && entry.status === "completed",
    );

    expect(pipelineCheck).toHaveLength(1);
    expect(pipelineCheck[0]?.conclusion).toBe("failure");
    expect(pipelineCheck[0]?.title).toContain("something went wrong");
  });
});

describe("deprecated APIs are marked", () => {
  const read = (file: string) =>
    readFile(join(import.meta.dirname, file), "utf8");

  test.each([
    ["unsupported.ts", "shell"],
    ["unsupported.ts", "oidc"],
    ["unsupported.ts", "vercel"],
    ["unsupported.ts", "rerunFromFailedJob"],
    ["cache.ts", "inngestCacheStore"],
    ["report.ts", "junit"],
  ])("%s marks %s @deprecated", async (file, name) => {
    const source = await read(file);
    const index = source.indexOf(`${name}`);

    expect(index).toBeGreaterThan(-1);
    // The JSDoc block immediately above the declaration carries the tag.
    expect(source.slice(Math.max(0, index - 600), index)).toContain(
      "@deprecated",
    );
  });

  test.each([
    ["types.ts", "image?: string"],
    ["types.ts", "arch?:"],
    ["types.ts", "withSecret(name: string, value: string): Command;"],
    ["types.ts", "url(port: number): string"],
  ])("%s marks %s @deprecated", async (file, name) => {
    const source = await read(file);
    const index = source.indexOf(name);

    expect(index).toBeGreaterThan(-1);
    expect(source.slice(Math.max(0, index - 400), index)).toContain(
      "@deprecated",
    );
  });
});
