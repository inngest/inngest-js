import { describe, expect, test } from "vitest";
import { cacheScopes, storeKey } from "./cache.ts";
import { buildArgv, buildShellString } from "./command.ts";
import { expandMatrix, matrixJobId, runPool } from "./createCi.ts";
import { behaviourFor } from "./durable.ts";
import {
  batchAnnotations,
  normaliseAnnotation,
  truncateSummary,
} from "./github/checks.ts";
import {
  githubEventName,
  githubWebhookTransform,
  repoContextFromEvent,
} from "./github/events.ts";
import { mapGitHubError } from "./github/rest.ts";
import {
  checkSuite,
  comment,
  hasPermission,
  mergeGroup,
  pullRequest,
  push,
} from "./github/triggers.ts";
import {
  durationToMs,
  filterPaths,
  formatDuration,
  formatRelative,
  globToRegExp,
  maskSecrets,
  shellEscape,
  truncateLabel,
} from "./util.ts";

describe("$ parsing", () => {
  const argv = (strings: string[], ...values: unknown[]) =>
    // biome-ignore lint/suspicious/noExplicitAny: mirrors a tagged template call
    buildArgv(strings, values as any);

  test("splits static text on whitespace", () => {
    expect(argv(["pnpm install --frozen-lockfile"])).toEqual([
      "pnpm",
      "install",
      "--frozen-lockfile",
    ]);
  });

  test("each interpolated value is one argument", () => {
    expect(argv(["pnpm --filter ", " test"], "my package")).toEqual([
      "pnpm",
      "--filter",
      "my package",
      "test",
    ]);
  });

  test("arrays spread into several arguments", () => {
    expect(argv(["pnpm test ", ""], ["--reporter", "json"])).toEqual([
      "pnpm",
      "test",
      "--reporter",
      "json",
    ]);
  });

  test("null, undefined, and false are dropped", () => {
    expect(argv(["pnpm test ", " ", ""], false, undefined)).toEqual([
      "pnpm",
      "test",
    ]);
    expect(argv(["pnpm test ", ""], null)).toEqual(["pnpm", "test"]);
  });

  test("a conditional array works", () => {
    const cond = true;
    expect(argv(["pnpm test ", ""], cond && ["--bail", "1"])).toEqual([
      "pnpm",
      "test",
      "--bail",
      "1",
    ]);
  });

  test("a value with no whitespace before it joins that argument", () => {
    expect(argv(["pnpm test --filter=", ""], "web")).toEqual([
      "pnpm",
      "test",
      "--filter=web",
    ]);
  });

  test("$.sh escapes interpolated values", () => {
    expect(
      buildShellString(
        ["echo ", " && pnpm test"],
        // biome-ignore lint/suspicious/noExplicitAny: mirrors a tagged template call
        ["it's fine"] as any,
      ),
    ).toBe(`echo 'it'\\''s fine' && pnpm test`);
  });

  test("shellEscape quotes quotes", () => {
    expect(shellEscape("a'b")).toBe(`'a'\\''b'`);
  });
});

describe("glob matching", () => {
  test.each([
    ["src/**", "src/a/b.ts", true],
    ["src/**", "src/a.ts", true],
    ["src/**", "test/a.ts", false],
    ["**/*.ts", "src/a/b.ts", true],
    ["**/*.ts", "a.ts", true],
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["{app,web}/**", "web/page.tsx", true],
    ["{app,web}/**", "api/page.tsx", false],
    ["pnpm-lock.yaml", "pnpm-lock.yaml", true],
  ])("%s matches %s → %s", (pattern, path, expected) => {
    expect(globToRegExp(pattern).test(path)).toBe(expected);
  });

  test("filterPaths honours include and ignore", () => {
    expect(
      filterPaths(["src/a.ts", "src/a.test.ts", "docs/x.md"], {
        include: ["src/**"],
        ignore: ["**/*.test.ts"],
      }),
    ).toEqual(["src/a.ts"]);
  });
});

describe("durable rules", () => {
  test("first match wins and `*` matches one segment", () => {
    const rules = [
      ["paginate.iterator", "unsupported"],
      ["*.*", "step"],
    ] as Array<[string, "step" | "direct" | "unsupported"]>;

    expect(behaviourFor(["paginate", "iterator"], rules)).toBe("unsupported");
    expect(behaviourFor(["repos", "get"], rules)).toBe("step");
    expect(behaviourFor(["repos"], rules)).toBe("direct");
    expect(behaviourFor(["a", "b", "c"], rules)).toBe("direct");
  });
});

describe("matrix", () => {
  const config: {
    id: string;
    axes: { node: string[]; db: string[] };
  } = {
    id: "compat",
    axes: { node: ["20", "22"], db: ["sqlite", "postgres"] },
  };

  test("expands every combination in declaration order", () => {
    expect(expandMatrix({ ...config })).toEqual([
      { node: "20", db: "sqlite" },
      { node: "20", db: "postgres" },
      { node: "22", db: "sqlite" },
      { node: "22", db: "postgres" },
    ]);
  });

  test("exclude removes combinations and include adds them", () => {
    expect(
      expandMatrix({
        ...config,
        exclude: [{ node: "20", db: "postgres" }],
        include: [{ node: "24", db: "postgres" }],
      }),
    ).toEqual([
      { node: "20", db: "sqlite" },
      { node: "22", db: "sqlite" },
      { node: "22", db: "postgres" },
      { node: "24", db: "postgres" },
    ]);
  });

  test("job IDs name their combination", () => {
    expect(matrixJobId("compat", { node: "20", db: "sqlite" })).toBe(
      "compat (node:20, db:sqlite)",
    );
  });
});

describe("matrix pool", () => {
  test("concurrency limits how many run at once", async () => {
    let running = 0;
    let peak = 0;

    const tasks = Array.from({ length: 6 }, () => async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running--;
      return 1;
    });

    const results = await runPool(tasks, 2, false);

    expect(results).toHaveLength(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("without failFast every task runs and failures throw together", async () => {
    const ran: number[] = [];

    const tasks = [0, 1, 2].map((index) => async () => {
      ran.push(index);
      if (index !== 1) {
        throw new Error(`boom ${index}`);
      }
      return index;
    });

    await expect(runPool(tasks, undefined, false)).rejects.toThrow(
      "2 job(s) failed",
    );
    expect(ran).toEqual([0, 1, 2]);
  });

  test("with failFast the first failure rejects", async () => {
    const tasks = [
      async () => {
        throw new Error("first");
      },
      async () => 2,
    ];

    await expect(runPool(tasks, 1, true)).rejects.toThrow("first");
  });
});

describe("GitHub triggers", () => {
  test("pull requests default to opened, synchronize, and reopened", () => {
    expect(pullRequest().map((trigger) => trigger.event)).toEqual([
      "github/pull_request.opened",
      "github/pull_request.synchronize",
      "github/pull_request.reopened",
    ]);
  });

  test("branches and repo become an if expression", () => {
    const [trigger] = pullRequest({
      branches: ["main", "next"],
      types: ["opened"],
      repo: "inngest/inngest-js",
    });

    expect(trigger?.if).toBe(
      '(event.data.pull_request.base.ref == "main" || event.data.pull_request.base.ref == "next") && (event.data.repository.full_name == "inngest/inngest-js")',
    );
  });

  test("pushes filter refs and exclude deletions", () => {
    const [trigger] = push({ branches: ["main"], tags: ["v*"] });

    expect(trigger?.event).toBe("github/push");
    expect(trigger?.if).toContain('event.data.ref == "refs/heads/main"');
    expect(trigger?.if).toContain('event.data.ref == "refs/tags/v*"');
    expect(trigger?.if).toContain("event.data.deleted != true");
  });

  test("comments match the command prefix", () => {
    const [trigger] = comment({ command: "/prerelease" });

    expect(trigger?.event).toBe("github/issue_comment.created");
    expect(trigger?.if).toContain(
      'event.data.comment.body.startsWith("/prerelease")',
    );
  });

  test("merge groups and check suites have triggers", () => {
    expect(mergeGroup()[0]?.event).toBe("github/merge_group.checks_requested");
    expect(checkSuite({ branch: "main" })[0]?.if).toContain(
      'event.data.check_suite.head_branch == "main"',
    );
  });

  test("permissions compare in order", () => {
    expect(hasPermission("admin", "write")).toBe(true);
    expect(hasPermission("read", "write")).toBe(false);
    expect(hasPermission("write", "write")).toBe(true);
    expect(hasPermission("none", "read")).toBe(false);
    expect(hasPermission(undefined, "read")).toBe(false);
  });
});

describe("webhook transform", () => {
  const transform = new Function(
    `${githubWebhookTransform}; return transform;`,
  )() as (
    evt: unknown,
    headers: Record<string, string>,
  ) => { name: string; data: Record<string, unknown> };

  test("names events with their action", () => {
    const result = transform(
      { action: "opened", pull_request: { number: 1 } },
      { "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": "abc" },
    );

    expect(result.name).toBe("github/pull_request.opened");
    expect(result.data._github).toMatchObject({
      event: "pull_request",
      delivery: "abc",
    });
  });

  test("names events without an action", () => {
    expect(
      transform({ ref: "refs/heads/main" }, { "x-github-event": "push" }).name,
    ).toBe("github/push");
  });

  test("carries the installation ID", () => {
    const result = transform(
      { action: "created", installation: { id: 99 } },
      { "x-github-event": "issue_comment" },
    );

    expect(result.name).toBe("github/issue_comment.created");
    expect(result.data._github).toMatchObject({ installationId: 99 });
  });

  test("the helper agrees with the transform", () => {
    expect(githubEventName("push", undefined)).toBe("github/push");
    expect(githubEventName("pull_request", { action: "opened" })).toBe(
      "github/pull_request.opened",
    );
  });
});

describe("repo context", () => {
  const repository = { full_name: "inngest/inngest-js" };

  test("pull requests carry head, base, and number", () => {
    const repo = repoContextFromEvent({
      name: "github/pull_request.opened",
      data: {
        repository,
        pull_request: {
          number: 7,
          head: { sha: "abc", ref: "feature", repo: repository },
          base: { sha: "def", ref: "main" },
        },
        _github: { installationId: 3 },
      },
    });

    expect(repo).toMatchObject({
      owner: "inngest",
      name: "inngest-js",
      sha: "abc",
      baseRef: "main",
      installationId: 3,
      pullRequest: { number: 7, headRef: "feature", fork: false },
    });
  });

  test("forks are marked", () => {
    const repo = repoContextFromEvent({
      name: "github/pull_request.opened",
      data: {
        repository,
        pull_request: {
          number: 7,
          head: { sha: "abc", ref: "f", repo: { full_name: "someone/fork" } },
          base: { sha: "def", ref: "main" },
        },
      },
    });

    expect(repo?.pullRequest?.fork).toBe(true);
  });

  test("pushes use after and before", () => {
    expect(
      repoContextFromEvent({
        name: "github/push",
        data: { repository, ref: "refs/heads/main", before: "a", after: "b" },
      }),
    ).toMatchObject({ sha: "b", baseSha: "a", baseRef: "main" });
  });

  test("triggers with no repository have no context", () => {
    expect(repoContextFromEvent({ name: "cron", data: {} })).toBeUndefined();
  });
});

describe("GitHub error mapping", () => {
  test("rate limits become RetryAfterError", () => {
    const error = mapGitHubError({
      status: 403,
      message: "API rate limit exceeded",
      response: {
        headers: {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1700000000",
        },
      },
    });

    expect(error?.name).toBe("RetryAfterError");
  });

  test("5xx keeps the original error so it retries normally", () => {
    expect(
      mapGitHubError({ status: 502, message: "bad gateway" }),
    ).toBeUndefined();
  });

  test("other 4xx are non-retriable", () => {
    const error = mapGitHubError({ status: 404, message: "Not Found" });

    expect(error?.name).toBe("NonRetriableError");
    expect(error?.message).toContain("404");
  });

  test("errors without a status are left alone", () => {
    expect(mapGitHubError(new Error("network"))).toBeUndefined();
  });
});

describe("check output limits", () => {
  test("summaries are truncated with a pointer to the trace", () => {
    const summary = truncateSummary("x".repeat(70_000));

    expect(summary.length).toBeLessThanOrEqual(65_000);
    expect(summary).toContain("truncated");
  });

  test("short summaries are untouched", () => {
    expect(truncateSummary("hello")).toBe("hello");
  });

  test("annotations batch in 50s", () => {
    const annotations = Array.from({ length: 120 }, (_, index) =>
      normaliseAnnotation({ path: "a.ts", line: index + 1, message: "x" }),
    );

    const batches = batchAnnotations(annotations);

    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
  });

  test("annotations get GitHub's shape", () => {
    expect(
      normaliseAnnotation({ path: "src/a.ts", line: 42, message: "flaky" }),
    ).toEqual({
      path: "src/a.ts",
      message: "flaky",
      start_line: 42,
      end_line: 42,
      annotation_level: "failure",
    });
  });
});

describe("cache scopes", () => {
  test("pull requests read their own scope then the base branch", () => {
    expect(
      cacheScopes(
        {
          owner: "o",
          name: "r",
          fullName: "o/r",
          sha: "abc",
          baseRef: "main",
          pullRequest: { number: 4, headRef: "f", fork: false },
        },
        undefined,
      ),
    ).toEqual({ read: ["pr-4", "main"], write: "pr-4" });
  });

  test("global scope ignores branches", () => {
    expect(
      cacheScopes(
        { owner: "o", name: "r", fullName: "o/r", sha: "abc" },
        "global",
      ),
    ).toEqual({ read: ["global"], write: "global" });
  });

  test("store keys include the scope and job", () => {
    expect(storeKey("main", "setup", "abc")).toBe("main:setup:abc");
  });
});

describe("formatting", () => {
  test("durations read as CI times", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(22_000)).toBe("22s");
    expect(formatDuration(65_000)).toBe("1m 05s");
  });

  test("relative times read as check summaries", () => {
    const now = Date.now();
    expect(
      formatRelative(new Date(now - 5 * 3_600_000).toISOString(), now),
    ).toBe("5h ago");
    expect(formatRelative(new Date(now - 30_000).toISOString(), now)).toBe(
      "just now",
    );
  });

  test("durations parse", () => {
    expect(durationToMs("10m")).toBe(600_000);
    expect(durationToMs("1h30m")).toBe(5_400_000);
    expect(durationToMs("250ms")).toBe(250);
    expect(() => durationToMs("soon")).toThrow();
  });

  test("labels truncate", () => {
    expect(truncateLabel("a".repeat(80))).toHaveLength(60);
    expect(truncateLabel("short")).toBe("short");
  });

  test("secrets are masked wherever they appear", () => {
    expect(maskSecrets("token=abc123 and abc123", ["abc123"])).toBe(
      "token=*** and ***",
    );
  });
});
