/**
 * Tests of invalidating a job's cached images: which names are a job's (every
 * scope or one, jobs whose IDs share a prefix or a suffix, names cut for
 * length), and what the function does with them (snapshots that are gone or
 * still being made, several pages, an app that doesn't define the job). They
 * seed named snapshots in the fake Sandboxes API and run the generated
 * function.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { formatName, parseName } from "../cache/names.ts";
import { consoleReporter } from "../github/auth.ts";
import { createCiTestClient } from "../testing/client.ts";
import type { FakeSnapshot } from "../testing/fakeSandbox.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";
import { invalidateEvent } from "./invalidate.ts";

/** A seeded snapshot: just a name, or a name with a status. */
type Seed = string | { name: string; status: string };

/** Answers a request with an error body, or passes it on to the fake. */
const failing = (
  fails: (url: URL, init?: RequestInit) => boolean,
  error: { code: string; status: number },
) => {
  return (inner: typeof fetch): typeof fetch => {
    return (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (!fails(url, init)) {
        return inner(input, init);
      }

      return new Response(
        JSON.stringify({ errors: [{ code: error.code, message: error.code }] }),
        {
          status: error.status,
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
  };
};

const setup = (
  seeds: Seed[],
  options: {
    /** Job IDs to register. */
    jobIds?: string[];
    /** Wraps the fake's `fetch`, to fail or page its answers. */
    wrapFetch?: (inner: typeof fetch) => typeof fetch;
  } = {},
) => {
  const { jobIds = ["a", "ab"], wrapFetch } = options;
  const api = createFakeSandboxApi();

  const client = createCiTestClient(
    wrapFetch ? { ...api, fetch: wrapFetch(api.fetch) } : api,
  );

  const ci = createCi(client, {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  for (const id of jobIds) {
    ci.job(id, async () => undefined);
  }

  const invalidate = ci.functions().find((fn) => {
    return fn.opts.id === "ci/invalidate";
  });

  const idsByName = new Map<string, string>();

  for (const seed of seeds) {
    const { name, status } =
      typeof seed === "string" ? { name: seed, status: "READY" } : seed;
    const id = crypto.randomUUID();

    idsByName.set(name, id);

    api.snapshots.set(id, {
      id,
      name,
      status,
      sandboxId: "sbx",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      // The fake's other fields vary by what's underneath this branch, and
      // nothing here reads them.
    } as FakeSnapshot);
  }

  const run = async (event: ReturnType<typeof invalidateEvent>) => {
    if (!invalidate) {
      throw new Error("no ci/invalidate function");
    }

    return runFunction(invalidate, { event });
  };

  const remaining = () => {
    return [...api.snapshots.values()].map((snapshot) => {
      return snapshot.name;
    });
  };

  return { run, remaining, idsByName };
};

const names = [
  "ci/main/a/k1",
  "ci/feature/x/a/k2",
  "ci/pr:7/a/k3",
  "ci/main/ab/k4",
  "ci/main/a/b/k5",
  "ci/main/other/k6",
];

describe("which snapshots are a job's", () => {
  const scopes = [
    "ci/pr:7/a/k1",
    "ci/pr:70/a/k2",
    "ci/run:abc/a/k3",
    "ci/run:abd/a/k4",
    "ci/main/a/k5",
  ];

  test.each([
    {
      case: "every scope",
      seeds: names,
      event: invalidateEvent("a"),
      kept: ["ci/main/ab/k4", "ci/main/a/b/k5", "ci/main/other/k6"],
    },
    {
      case: "one scope, with a slash in it",
      seeds: names,
      event: invalidateEvent("a", { scope: "feature/x" }),
      kept: names.filter((name) => {
        return name !== "ci/feature/x/a/k2";
      }),
    },
    {
      case: "not a job whose ID shares a prefix or is a longer path",
      seeds: names,
      event: invalidateEvent("a", { scope: "main" }),
      kept: names.filter((name) => {
        return name !== "ci/main/a/k1";
      }),
    },
    {
      case: "a PR scope and no other",
      seeds: scopes,
      event: invalidateEvent("a", { scope: "pr:7" }),
      kept: scopes.slice(1),
    },
    {
      case: "a run scope and no other",
      seeds: scopes,
      event: invalidateEvent("a", { scope: "run:abc" }),
      kept: scopes.filter((name) => {
        return name !== "ci/run:abc/a/k3";
      }),
    },
  ])("deletes $case", async ({ seeds, event, kept }) => {
    const { run, remaining } = setup(seeds);

    await run(event);

    expect(remaining()).toEqual(kept);
  });

  test("tells a job apart from one whose ID ends with its own", async () => {
    const seeds = ["ci/main/b/k1", "ci/main/a/b/k2", "ci/feature/x/b/k3"];

    const { run, remaining } = setup(seeds, { jobIds: ["b", "a/b"] });

    await run(invalidateEvent("b"));

    expect(remaining()).toEqual(["ci/main/a/b/k2"]);
  });

  test("deletes names cut for length", async () => {
    const name = (scope: string, jobId: string) => {
      return formatName({ kind: "cache", scope, jobId, ownKey: "key" });
    };

    const job = "j".repeat(300);
    const long = name("main", job);
    const other = name("main", "k".repeat(300));
    const elsewhere = name("feature/x", job);

    expect(long).toHaveLength(255);

    const everywhere = setup([long, other, elsewhere], { jobIds: [job] });

    await everywhere.run(invalidateEvent(job));

    expect(everywhere.remaining()).toEqual([other]);

    const scoped = setup([long, other, elsewhere], { jobIds: [job] });

    await scoped.run(invalidateEvent(job, { scope: "main" }));

    expect(scoped.remaining()).toEqual([other, elsewhere]);
  });
});

describe("parseName", () => {
  test.each([
    ["ci/main/a/k1", { kind: "cache", scope: "main", jobId: "a" }],
    ["ci/feature/x/a/k1", { kind: "cache", scope: "feature/x", jobId: "a" }],
    ["ci/main/a/b/k1", { kind: "cache", scope: "main", jobId: "a/b" }],
    ["ci/run:abc/a/b/k1", { kind: "run", rootRunId: "abc", jobId: "a/b" }],
  ])("reads %s", (name, expected) => {
    expect(parseName(name, ["a", "a/b"])).toEqual({
      ...expected,
      ownKey: "k1",
    });
  });

  test.each(["main/a/k1", "ci/main/z/k1", "ci/a/k1", "ci/main"])(
    "reads %s as not one of a known job's",
    (name) => {
      expect(parseName(name, ["a"])).toBeUndefined();
    },
  );

  test("round-trips what formatName builds", () => {
    const name = {
      kind: "cache",
      scope: "feature/x",
      jobId: "a/b",
      ownKey: "k",
    } as const;

    expect(parseName(formatName(name), ["a/b"])).toEqual(name);
  });
});

describe("invalidate", () => {
  test("reports what it deleted, and does nothing for a job the app doesn't define", async () => {
    const { run, remaining } = setup(names);

    const result = await run(invalidateEvent("a"));

    expect(result.data).toMatchObject({ outcome: "invalidated", deleted: 3 });

    const missing = await run(invalidateEvent("missing"));

    expect(missing.data).toEqual({ outcome: "unknown-job", job: "missing" });
    expect(remaining()).toHaveLength(names.length - 3);
  });

  test("skips snapshots that are already gone", async () => {
    const seeds = ["ci/main/a/k1", "ci/main/a/k2", "ci/main/a/k3"];
    let gone = "";

    const { run, remaining, idsByName } = setup(seeds, {
      wrapFetch: failing(
        (url) => {
          return url.pathname === `/v2/snapshots/${gone}`;
        },
        { code: "sandbox_snapshot_not_found", status: 404 },
      ),
    });

    gone = idsByName.get("ci/main/a/k2") ?? "";

    const result = await run(invalidateEvent("a"));

    expect(result.data).toMatchObject({ outcome: "invalidated", deleted: 2 });
    expect(remaining()).toEqual(["ci/main/a/k2"]);
  });

  test("rethrows other failures", async () => {
    const { run } = setup(["ci/main/a/k1"], {
      wrapFetch: failing(
        (url) => {
          return /^\/v2\/snapshots\/[^/]+$/.test(url.pathname);
        },
        { code: "boom", status: 400 },
      ),
    });

    const result = await run(invalidateEvent("a"));

    expect(result.error).toBeDefined();
  });

  test("leaves snapshots that are still being created", async () => {
    const { run, remaining } = setup([
      "ci/main/a/k1",
      { name: "ci/main/a/k2", status: "CREATING" },
    ]);

    const result = await run(invalidateEvent("a"));

    expect(result.data).toMatchObject({
      outcome: "invalidated",
      deleted: 1,
      skipped: 1,
      names: ["ci/main/a/k1"],
    });
    expect(remaining()).toEqual(["ci/main/a/k2"]);
  });

  test("reads every page of snapshots", async () => {
    const seeds = [
      "ci/main/a/k1",
      "ci/main/other/k2",
      "ci/main/a/k3",
      "ci/feature/x/a/k4",
    ];

    const { run, remaining } = setup(seeds, {
      wrapFetch: (inner) => {
        return (async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );

          if (url.pathname !== "/v2/snapshots" || init?.method === "DELETE") {
            return inner(input, init);
          }

          const body = (await (await inner(input, init)).json()) as {
            data: unknown[];
          };
          const second = url.searchParams.get("cursor") === "page-2";
          const half = Math.ceil(body.data.length / 2);

          return new Response(
            JSON.stringify({
              ...body,
              data: second ? body.data.slice(half) : body.data.slice(0, half),
              page: second
                ? { hasMore: false, limit: 2 }
                : { hasMore: true, limit: 2, cursor: "page-2" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch;
      },
    });

    const result = await run(invalidateEvent("a"));

    expect(result.data).toMatchObject({ deleted: 3 });
    expect(remaining()).toEqual(["ci/main/other/k2"]);
  });

  test("lists at most 20 names but counts them all", async () => {
    const seeds = Array.from({ length: 25 }, (_, i) => {
      return `ci/main/a/k${i}`;
    });

    const { run, remaining } = setup(seeds);

    const result = await run(invalidateEvent("a"));
    const data = result.data as { deleted: number; names: string[] };

    expect(data.deleted).toBe(25);
    expect(data.names).toHaveLength(20);
    expect(remaining()).toEqual([]);
  });

  test("rejects a missing job and an empty scope", async () => {
    const { run } = setup([]);

    const missing = await run({
      name: "ci/base-image.invalidate",
      data: {},
    } as ReturnType<typeof invalidateEvent>);

    expect(missing.error).toMatchObject({ name: "NonRetriableError" });

    const empty = await run(invalidateEvent("a", { scope: "" }));

    expect(empty.error).toMatchObject({ name: "NonRetriableError" });
  });
});
