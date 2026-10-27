/**
 * Unit tests for pure helpers across the package: parsing, matching, matrix
 expansion, GitHub mapping, cache scopes and formatting.
 *
 * @module
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { cacheScopes, lookupCache } from "./cache/cache.ts";
import { formatName } from "./cache/names.ts";
import { CiUsageError, CommandFailedError } from "./errors.ts";
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
import { buildArgv, buildShellString } from "./machine/command.ts";
import { machineSetupScript } from "./machine/machine.ts";
import { behaviourFor } from "./pipeline/durable.ts";
import {
  expandMatrix,
  matrixJobId,
  runPool,
  sameCombo,
} from "./pipeline/matrix.ts";
import { temporalDuration } from "./testing/temporal.ts";
import {
  durationToMs,
  failureLine,
  fenceFor,
  filterPaths,
  formatDuration,
  formatRelative,
  globToRegExp,
  maskSecrets,
  shellEscape,
  shortReason,
  stableStringify,
  stripAnsi,
  truncateLabel,
} from "./util.ts";

describe("$ parsing", () => {
  const argv = (strings: string[], ...values: unknown[]) => {
    // biome-ignore lint/suspicious/noExplicitAny: mirrors a tagged template call
    return buildArgv(strings, values as any);
  };

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
      ["paginate.iterator", "direct"],
      ["*.*", "step"],
    ] as Array<[string, "step" | "direct"]>;

    expect(behaviourFor(["paginate", "iterator"], rules)).toBe("direct");
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
    expect(expandMatrix({}, config.axes)).toEqual([
      { node: "20", db: "sqlite" },
      { node: "20", db: "postgres" },
      { node: "22", db: "sqlite" },
      { node: "22", db: "postgres" },
    ]);
  });

  test("exclude removes combinations and include adds them", () => {
    expect(
      expandMatrix(
        {
          exclude: [{ node: "20", db: "postgres" }],
          include: [{ node: "24", db: "postgres" }],
        },
        config.axes,
      ),
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

describe("matrix combinations compare by value", () => {
  test("object values match after a round trip", () => {
    const combo = { node: "22", env: { region: "eu", tier: ["a", "b"] } };

    expect(sameCombo(combo, JSON.parse(JSON.stringify(combo)))).toBe(true);
    expect(sameCombo(combo, { ...combo, env: { region: "us" } })).toBe(false);
    expect(sameCombo({ node: "22" }, { node: "20" })).toBe(false);
  });
});

describe("matrix pool", () => {
  test("concurrency limits how many run at once", async () => {
    let running = 0;
    let peak = 0;
    let finished = 0;

    const tasks = Array.from({ length: 6 }, () => {
      return async () => {
        running++;

        peak = Math.max(peak, running);

        await new Promise((resolve) => {
          return setTimeout(resolve, 1);
        });

        running--;
        finished++;
      };
    });

    await runPool(tasks, 2, false);

    expect(finished).toBe(6);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("without failFast every task runs and failures throw together", async () => {
    const ran: number[] = [];

    const tasks = [0, 1, 2].map((index) => {
      return async () => {
        ran.push(index);

        if (index !== 1) {
          throw new Error(`boom ${index}`);
        }
      };
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
      async () => {
        return;
      },
    ];

    await expect(runPool(tasks, 1, true)).rejects.toThrow("first");
  });

  test("with failFast, queued tasks don't start after a failure", async () => {
    const started: number[] = [];

    const tasks = [
      async () => {
        started.push(0);

        throw new Error("first");
      },
      async () => {
        started.push(1);

        await new Promise((resolve) => {
          return setTimeout(resolve, 20);
        });
      },
      async () => {
        started.push(2);
      },
    ];

    await expect(runPool(tasks, 2, true)).rejects.toThrow("first");

    // Let the task that was already running finish and look for more work.
    await new Promise((resolve) => {
      return setTimeout(resolve, 50);
    });

    expect(started).toEqual([0, 1]);
  });
});

describe("GitHub triggers", () => {
  test("pull requests default to opened, synchronize, and reopened", () => {
    expect(
      pullRequest().map((trigger) => {
        return trigger.event;
      }),
    ).toEqual([
      "github-ci/pull_request.opened",
      "github-ci/pull_request.synchronize",
      "github-ci/pull_request.reopened",
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

    expect(trigger?.event).toBe("github-ci/push");
    expect(trigger?.if).toContain('event.data.ref == "refs/heads/main"');
    expect(trigger?.if).toContain('event.data.ref == "refs/tags/v*"');
    expect(trigger?.if).toContain("event.data.deleted != true");
  });

  test("comments match the command prefix", () => {
    const [trigger] = comment({ command: "/prerelease" });

    expect(trigger?.event).toBe("github-ci/issue_comment.created");

    expect(trigger?.if).toContain(
      'event.data.comment.body.startsWith("/prerelease")',
    );
  });

  test("merge groups and check suites have triggers", () => {
    expect(mergeGroup()[0]?.event).toBe(
      "github-ci/merge_group.checks_requested",
    );

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
  ) => {
    name: string;
    data: Record<string, unknown>;
    meta: { sessions: Record<string, string | number> };
  };

  test("names events with their action", () => {
    const result = transform(
      { action: "opened", pull_request: { number: 1 } },
      { "X-GitHub-Event": "pull_request", "X-GitHub-Delivery": "abc" },
    );

    expect(result.name).toBe("github-ci/pull_request.opened");

    expect(result.data._github).toMatchObject({
      event: "pull_request",
      delivery: "abc",
    });
  });

  test("names events without an action", () => {
    expect(
      transform({ ref: "refs/heads/main" }, { "x-github-event": "push" }).name,
    ).toBe("github-ci/push");
  });

  test("carries the installation ID", () => {
    const result = transform(
      { action: "created", installation: { id: 99 } },
      { "x-github-event": "issue_comment" },
    );

    expect(result.name).toBe("github-ci/issue_comment.created");
    expect(result.data._github).toMatchObject({ installationId: 99 });
  });

  test.each([
    {
      event: "pull_request",
      payload: {
        action: "opened",
        repository: { full_name: "inngest/inngest-js" },
        pull_request: { number: 7, head: { sha: "abc1234" } },
      },
      sessions: { pull_request: "inngest/inngest-js#7", commit: "abc1234" },
    },
    {
      event: "push",
      payload: {
        repository: { full_name: "inngest/inngest-js" },
        after: "def5678",
      },
      sessions: { commit: "def5678" },
    },
    {
      event: "push",
      payload: {
        repository: { full_name: "inngest/inngest-js" },
        after: "0000000000000000000000000000000000000000",
      },
      sessions: {},
    },
    {
      event: "issue_comment",
      payload: {
        action: "created",
        repository: { full_name: "inngest/inngest-js" },
        issue: { number: 9, pull_request: {} },
      },
      sessions: { pull_request: "inngest/inngest-js#9" },
    },
    {
      event: "check_suite",
      payload: {
        action: "rerequested",
        repository: { full_name: "inngest/inngest-js" },
        check_suite: { head_sha: "fedcba9" },
      },
      sessions: { commit: "fedcba9" },
    },
    { event: "ping", payload: {}, sessions: {} },
  ])("puts a $event in its sessions", ({ event, payload, sessions }) => {
    expect(
      transform(payload, { "x-github-event": event }).meta.sessions,
    ).toEqual(sessions);
  });

  test("the helper agrees with the transform", () => {
    expect(githubEventName("push", undefined)).toBe("github-ci/push");

    expect(githubEventName("pull_request", { action: "opened" })).toBe(
      "github-ci/pull_request.opened",
    );
  });
});

describe("repo context", () => {
  const repository = { full_name: "inngest/inngest-js" };

  test("pull requests carry head, base, and number", () => {
    const repo = repoContextFromEvent({
      name: "github-ci/pull_request.opened",
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
      name: "github-ci/pull_request.opened",
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
        name: "github-ci/push",
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
    const annotations = Array.from({ length: 120 }, (_, index) => {
      return normaliseAnnotation({
        path: "a.ts",
        line: index + 1,
        message: "x",
      });
    });

    const batches = batchAnnotations(annotations);

    expect(
      batches.map((batch) => {
        return batch.length;
      }),
    ).toEqual([50, 50, 20]);
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
    ).toEqual({ read: ["pr:4", "main"], write: "pr:4" });
  });

  test("a branch named like a pull request has its own scope", () => {
    const repo = { owner: "o", name: "r", fullName: "o/r", sha: "abc" };

    const branch = cacheScopes({ ...repo, ref: "refs/heads/pr-4" }, undefined);

    const pullRequest = cacheScopes(
      {
        ...repo,
        baseRef: "main",
        pullRequest: { number: 4, headRef: "f", fork: false },
      },
      undefined,
    );

    expect(branch.write).not.toBe(pullRequest.write);
    expect(pullRequest.read).not.toContain(branch.write);
  });

  test("global scope ignores branches", () => {
    expect(
      cacheScopes(
        { owner: "o", name: "r", fullName: "o/r", sha: "abc" },
        "global",
      ),
    ).toEqual({ read: ["global"], write: "global" });
  });

  describe("a local run writes only to its own scope, and reads what CI built", () => {
    const local = { path: "/repo", baseRef: "main" };
    const repo = { owner: "o", name: "r", fullName: "o/r", sha: "abc" };

    test.each([
      [
        "a pull request fixture",
        {
          ...repo,
          baseRef: "main",
          pullRequest: { number: 1, headRef: "f", fork: false },
        },
        undefined,
        ["local", "main"],
      ],
      [
        "a push fixture",
        { ...repo, ref: "refs/heads/main" },
        undefined,
        ["local", "main"],
      ],
      ["global scope", repo, "global" as const, ["local", "global"]],
    ])("%s", (_label, fixture, scope, read) => {
      expect(cacheScopes({ ...fixture, local }, scope)).toEqual({
        read,
        write: "local",
      });
    });
  });
});

describe("formatting", () => {
  test("durations read as CI times", () => {
    expect(formatDuration(500)).toBe("500ms");
    expect(formatDuration(22_000)).toBe("22s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(1500, true)).toBe("1500ms");
    expect(formatDuration(65_000, true)).toBe("1m 05s");
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

  test.each([
    ["10m", 600_000],
    ["1h30m", 5_400_000],
    ["1h 30m", 5_400_000],
    ["250ms", 250],
    // A bare number in a string is milliseconds.
    ["10", 10],
    [90_000, 90_000],
    [temporalDuration(5_000), 5_000],
  ])("the duration %j is %d ms", (duration, expected) => {
    expect(durationToMs(duration, "timeout")).toBe(expected);
  });

  test.each([
    "soon",
    "1 month",
    "1h garbage",
    "",
    "m5",
    "-5m",
    "0s",
    0,
    -1,
    1.5,
    temporalDuration(5_000, { weeks: 1 }),
  ])("the duration %j is rejected, naming the field", (bad) => {
    expect(() => {
      return durationToMs(bad, "cache.maxAge");
    }).toThrow(CiUsageError);

    expect(() => {
      return durationToMs(bad, "cache.maxAge");
    }).toThrow(/cache\.maxAge/);
  });

  test("stable strings ignore key order", () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(
      stableStringify({ a: { d: [1, 2] }, b: 1 }),
    );

    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
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

describe("looking a cached snapshot up by name", () => {
  const name = formatName({
    kind: "cache",
    scope: "global",
    jobId: "setup",
    ownKey: "k1",
  });

  // One moment for every fixture, so two snapshots built apart still match.
  const now = Date.now();

  const inHours = (hours: number) => {
    return new Date(now + hours * 3_600_000).toISOString();
  };

  const snapshot = (fields: Record<string, unknown>) => {
    return {
      id: "s1",
      name,
      status: "READY",
      createdAt: inHours(-1),
      expiresAt: inHours(10),
      ...fields,
    };
  };

  /** A job scope just big enough for a lookup, over a list and a get. */
  const lookup = async (
    list: () => Promise<unknown>,
    get: () => Promise<unknown> = async () => {
      return null;
    },
    exclude?: string,
  ) => {
    const scope = {
      path: "setup",
      config: { id: "setup" },
      run: {
        step: {
          run: async (_id: unknown, fn: () => Promise<unknown>) => {
            return fn();
          },
        },
        ci: { client: { sandboxes: { snapshots: { list, get } } } },
      },
    } as never;

    return lookupCache(
      scope,
      { key: "v1", scope: "global" },
      { ownKey: "k1", key: {}, name },
      exclude,
    );
  };

  const listing = (...items: unknown[]) => {
    return async () => {
      return { items };
    };
  };

  test.each([
    ["a READY snapshot well before its expiry", listing(snapshot({})), "s1"],
    [
      "a snapshot past its expiry",
      listing(snapshot({ expiresAt: inHours(-1) })),
      undefined,
    ],
    [
      "a snapshot that expires within the margin",
      listing(snapshot({ expiresAt: inHours(0.1) })),
      undefined,
    ],
    [
      "a snapshot that failed",
      listing(snapshot({ status: "FAILED" })),
      undefined,
    ],
    [
      "another snapshot, from a server that ignores the name",
      listing(snapshot({ name: undefined })),
      undefined,
    ],
    [
      "a list the server refuses",
      async () => {
        throw new Error("unknown query parameter: name");
      },
      undefined,
    ],
    ["nothing", listing(), undefined],
  ])("%s gives %s", async (_label, list, expected) => {
    expect((await lookup(list))?.snapshotId).toBe(expected);
  });

  test("only the newest snapshot with the name counts", async () => {
    const found = await lookup(
      listing(snapshot({ id: "s2", status: "FAILED" }), snapshot({})),
    );

    expect(found).toBeUndefined();
  });

  test("a snapshot still being created is waited for", async () => {
    const found = await lookup(
      listing(snapshot({ status: "CREATING" })),
      async () => {
        return snapshot({});
      },
    );

    expect(found).toEqual({
      snapshotId: "s1",
      name,
      createdAt: snapshot({}).createdAt,
    });
  });

  test("a snapshot found to be bad is never found again", async () => {
    expect(await lookup(listing(snapshot({})), undefined, "s1")).toBe(
      undefined,
    );
  });
});

describe("snapshot names", () => {
  test("say what they are for", () => {
    expect(
      formatName({
        kind: "cache",
        scope: "pr:4",
        jobId: "setup",
        ownKey: "abc",
      }),
    ).toBe("ci/pr:4/setup/abc");
  });

  test("too long a name keeps its start and stays unique", () => {
    const long = formatName({
      kind: "cache",
      scope: "main",
      jobId: "j".repeat(300),
      ownKey: "abc",
    });
    const other = formatName({
      kind: "cache",
      scope: "main",
      jobId: "j".repeat(300),
      ownKey: "abd",
    });

    expect(long).toHaveLength(255);
    expect(long.startsWith("ci/main/jjj")).toBe(true);
    expect(long).not.toBe(other);
  });

  test("too long a name keeps its last part and stays apart from other names", () => {
    const name = (jobId: string, ownKey: string) => {
      return formatName({
        kind: "cache",
        scope: "main",
        jobId,
        ownKey: `repo/${ownKey}`,
      });
    };

    expect(name("j".repeat(300), "a")).toHaveLength(255);
    expect(name("j".repeat(300), "a").endsWith("/a")).toBe(true);

    // Differing only after the cut-off point of a long name.
    expect(name(`${"j".repeat(300)}1`, "a")).not.toBe(
      name(`${"j".repeat(300)}2`, "a"),
    );
  });
});

describe("shortReason", () => {
  test("Sandbox errors get fixed wording, from the code or its cause", () => {
    expect(shortReason({ code: "sandbox_start_failed" })).toBe(
      "machine failed to start",
    );

    expect(shortReason({ cause: { code: "cloud_login_required" } })).toBe(
      "not logged in to Inngest",
    );

    expect(
      shortReason({ code: "ERR_JOB", cause: { code: "access_denied" } }),
    ).toBe("Sandboxes not enabled for your account");
  });

  test("an unknown code falls back to the message", () => {
    expect(shortReason({ code: "constructor", message: "boom" })).toBe("boom");
  });

  test("a start timeout says how long it waited", () => {
    expect(
      shortReason(
        new Error("Sandbox did not reach RUNNING within 90000 milliseconds"),
      ),
    ).toBe("machine didn't start in 1m 30s");
  });

  test("anything else is its first line, trimmed and capped", () => {
    expect(
      shortReason(new Error("\n  NonRetriableError: Error: nope.\nmore")),
    ).toBe("nope");

    expect(shortReason(new Error("a".repeat(100)))).toBe(`${"a".repeat(59)}…`);

    expect(shortReason(undefined)).toBe("");
  });
});

const dogfoodRun5 = {
  stderr: [
    "Testing types with tsc and vue-tsc is an experimental feature.",
    "(node:605) [DEP0190] DeprecationWarning: Passing args to a child process with shell option true can lead to security vulnerabilities",
    "No test files found, exiting with code 1",
    "",
    "\u23af\u23af\u23af\u23af\u23af\u23af Unhandled Error \u23af\u23af\u23af\u23af\u23af\u23af\u23af",
    "Error: Dev Server startup timed out after 60 seconds",
    " \u276f Timeout._onTimeout ../test-harness/src/devServer.ts:75:16",
    "",
    "close timed out after 10000ms",
    "Tests closed successfully but something prevents Vite server from exiting",
    'You can try to identify the cause by enabling "hanging-process" reporter.',
  ].join("\n"),
  stdout: [
    "Starting Inngest Dev Server...",
    "Stopping Inngest Dev Server...",
    "/work/packages/inngest:",
    " ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  inngest@4.25.0 test:integration: `vitest run`",
    "Exit status 1",
  ].join("\n"),
};

describe("failureLine", () => {
  test("the first strong error wins over teardown noise that follows it", () => {
    expect(failureLine(dogfoodRun5.stderr, dogfoodRun5.stdout)).toBe(
      "Error: Dev Server startup timed out after 60 seconds",
    );
  });

  test("a runner's shutdown chatter is never the reason", () => {
    expect(
      failureLine(
        "close timed out after 10000ms\nTests closed successfully but something prevents Vite server from exiting",
        " ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  x: `vitest`\nExit status 1",
      ),
    ).toBe("");
  });

  const vitestOutput = [
    "FAIL  src/a.test.ts > adds",
    "AssertionError: expected 1 to be 2",
    "",
    "\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af\u23af[1/1]\u23af",
    "}",
    "Exit status 1",
  ].join("\n");

  test.each([
    ["a closing brace", "ran 3 tests\n}\n", "", "ran 3 tests"],
    ["a vitest separator", "", vitestOutput, "FAIL  src/a.test.ts > adds"],
    [
      "the rmdir TypeError",
      'TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined\n    at rmdir\n}\nExit status 1',
      "",
      'TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string. Received undefined',
    ],
    [
      "a missing binary",
      "bun: not found\nExit status 127",
      "",
      "bun: not found",
    ],
    [
      "a startup timeout",
      "",
      "starting\nDev Server startup timed out after 60 seconds\n]",
      "Dev Server startup timed out after 60 seconds",
    ],
    [
      "ANSI codes",
      "\u001b[31mError: red\u001b[39m\nExit status 1",
      "",
      "Error: red",
    ],
    [
      "stdout when stderr is empty",
      "",
      "all quiet\nbuilt nothing",
      "built nothing",
    ],
    ["no output", "", "", ""],
  ])("%s", (_name, stderr, stdout, expected) => {
    expect(failureLine(stderr, stdout)).toBe(expected);
  });

  test("an error in stdout beats a plain last line of stderr", () => {
    expect(failureLine("done", "Error: boom")).toBe("Error: boom");
  });

  test("is cut to a status description", () => {
    expect(failureLine("Error: " + "a".repeat(200), "")).toHaveLength(140);
  });
});

describe("stripAnsi", () => {
  test.each([
    ["colour codes", "\u001b[31mred\u001b[39m text", "red text"],
    [
      "an escape byte that became U+FFFD",
      "\uFFFD[1m\uFFFD[32mok\uFFFD[0m",
      "ok",
    ],
    ["a tail cut inside a sequence at its start", "[39m done", " done"],
    ["a tail cut inside a sequence at its end", "done \u001b[3", "done "],
    ["a tail cut right after the escape", "done \u001b", "done "],
    [
      "text that only looks like a code",
      "[1/2] built 5m ago",
      "[1/2] built 5m ago",
    ],
  ])("%s", (_name, input, expected) => {
    expect(stripAnsi(input)).toBe(expected);
  });
});

describe("fenceFor", () => {
  test.each([
    ["none inside", "plain", "```"],
    ["a fence inside", "a\n```\nb", "````"],
    ["a longer run inside", "`````", "``````"],
  ])("%s", (_name, text, fence) => {
    expect(fenceFor(text)).toBe(fence);
  });
});

describe("localhost setup in /etc/hosts", () => {
  const hostsAfterSetup = (initial: string): string => {
    const file = join(mkdtempSync(join(tmpdir(), "hosts-")), "hosts");

    writeFileSync(file, initial);

    const lines = machineSetupScript
      .split(" && ")
      .filter((line) => {
        return line.includes("/etc/hosts");
      })
      .map((line) => {
        return line.replaceAll("/etc/hosts", file);
      });

    execFileSync("bash", ["-c", lines.join(" && ")]);

    return readFileSync(file, "utf8");
  };

  test("adds both loopback lines when missing", () => {
    expect(hostsAfterSetup("")).toBe("127.0.0.1 localhost\n::1 localhost\n");
  });

  test("leaves an existing localhost entry alone", () => {
    const hosts = "127.0.0.1 localhost\n::1 ip6-localhost localhost\n";

    expect(hostsAfterSetup(hosts)).toBe(hosts);
  });

  test("an alias such as localhost.localdomain does not count", () => {
    const hosts = hostsAfterSetup(
      "127.0.0.1 localhost.localdomain # localhost\n",
    );

    expect(hosts).toContain("\n127.0.0.1 localhost\n");
  });
});

describe("CommandFailedError message", () => {
  const failure = (stdoutTail: string, stderrTail: string) => {
    return new CommandFailedError({
      command: ["pnpm", "test"],
      exitCode: 1,
      stdoutTail,
      stderrTail,
      jobPath: "a",
    });
  };

  test("prefers stderr", () => {
    expect(failure("out", "err").message).toBe(
      "`pnpm test` exited with 1\nerr",
    );
  });

  test("falls back to stdout when stderr is empty", () => {
    expect(failure("out", "").message).toBe("`pnpm test` exited with 1\nout");
  });
});
