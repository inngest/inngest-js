/**
 * Unit tests for pure helpers across the package: parsing, matching, matrix
 expansion, GitHub mapping, cache scopes and formatting.
 *
 * @module
 */

import { Temporal } from "temporal-polyfill";
import { describe, expect, test } from "vitest";
import { cacheScopes, lookupCache, snapshotName } from "./cache/cache.ts";
import { CiUsageError } from "./errors.ts";
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
import { behaviourFor } from "./pipeline/durable.ts";
import {
  expandMatrix,
  matrixJobId,
  runPool,
  sameCombo,
} from "./pipeline/matrix.ts";
import {
  durationToMs,
  filterPaths,
  formatDuration,
  formatRelative,
  globToRegExp,
  maskSecrets,
  shellEscape,
  shortReason,
  stableStringify,
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
    expect(durationToMs("10m", "timeout")).toBe(600_000);
    expect(durationToMs("1h30m", "timeout")).toBe(5_400_000);
    expect(durationToMs("1h 30m", "timeout")).toBe(5_400_000);
    expect(durationToMs("250ms", "timeout")).toBe(250);
    expect(durationToMs("1d", "timeout")).toBe(86_400_000);
    expect(durationToMs("1.5s", "timeout")).toBe(1500);
  });

  test("numbers are milliseconds", () => {
    expect(durationToMs(90_000, "timeout")).toBe(90_000);
  });

  test("Temporal durations convert to milliseconds", () => {
    expect(
      durationToMs(Temporal.Duration.from({ days: 1 }), "cache.maxAge"),
    ).toBe(86_400_000);
    expect(
      durationToMs(
        Temporal.Duration.from({ hours: 1, minutes: 30 }),
        "timeout",
      ),
    ).toBe(5_400_000);
  });

  test("malformed durations are rejected, naming the field", () => {
    const bad = [
      "soon",
      "1 month garbage",
      "1h garbage",
      "",
      "m5",
      "-5m",
      0,
      -1,
      Number.NaN,
      true,
      null,
      Temporal.Duration.from({ weeks: 1 }),
    ];

    for (const value of bad) {
      expect(() => {
        return durationToMs(value as string, "cache.maxAge");
      }).toThrow(CiUsageError);

      expect(() => {
        return durationToMs(value as string, "cache.maxAge");
      }).toThrow(/cache\.maxAge/);
    }
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

describe("looking a cached snapshot up by name", () => {
  const name = snapshotName("global", "setup", "k1");

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
      { ownKey: "k1", name },
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
    expect(snapshotName("pr:4", "setup", "abc")).toBe("ci/pr:4/setup/abc");
  });

  test("too long a name keeps its start and stays unique", () => {
    const long = snapshotName("main", "j".repeat(300), "abc");
    const other = snapshotName("main", "j".repeat(300), "abd");

    expect(long).toHaveLength(255);
    expect(long.startsWith("ci/main/jjj")).toBe(true);
    expect(long).not.toBe(other);
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
