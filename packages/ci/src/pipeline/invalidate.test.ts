/**
 * Tests of invalidating a job's cached images: every scope or one, jobs whose
 * IDs share a prefix or a suffix, names cut for length, snapshots that are gone
 * or still being made, several pages of snapshots, and an app that doesn't
 * define the job. They seed named
 * snapshots in the fake Sandboxes API and run the generated function.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { snapshotName } from "../cache/cache.ts";
import { createCi } from "./createCi.ts";
import { invalidateEvent } from "./invalidate.ts";

/** A seeded snapshot: just a name, or a name with a status. */
type Seed = string | { name: string; status: string };

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
    });
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

describe("invalidate", () => {
  test("deletes a job's snapshots in every scope", async () => {
    const { run, remaining } = setup(names);

    const result = await run(invalidateEvent("a"));

    expect(result.data).toMatchObject({ outcome: "invalidated", deleted: 3 });
    expect(remaining()).toEqual([
      "ci/main/ab/k4",
      "ci/main/a/b/k5",
      "ci/main/other/k6",
    ]);
  });

  test("deletes only the scope it was given", async () => {
    const { run, remaining } = setup(names);

    await run(invalidateEvent("a", { scope: "feature/x" }));

    expect(remaining()).toEqual([
      "ci/main/a/k1",
      "ci/pr:7/a/k3",
      "ci/main/ab/k4",
      "ci/main/a/b/k5",
      "ci/main/other/k6",
    ]);
  });

  test("doesn't match a job whose ID shares a prefix", async () => {
    const { run, remaining } = setup(names);

    await run(invalidateEvent("a", { scope: "main" }));

    expect(remaining()).toContain("ci/main/ab/k4");
    expect(remaining()).toContain("ci/main/a/b/k5");
    expect(remaining()).not.toContain("ci/main/a/k1");
  });

  test("does nothing for a job the app doesn't define", async () => {
    const { run, remaining } = setup(names);

    const result = await run(invalidateEvent("missing"));

    expect(result.data).toEqual({ outcome: "unknown-job", job: "missing" });
    expect(remaining()).toHaveLength(names.length);
  });

  test("deletes names cut for length", async () => {
    const job = "j".repeat(300);
    const long = snapshotName("main", job, "key");
    const other = snapshotName("main", "k".repeat(300), "key");
    const elsewhere = snapshotName("feature/x", job, "key");

    expect(long).toHaveLength(255);

    const everywhere = setup([long, other, elsewhere], { jobIds: [job] });

    await everywhere.run(invalidateEvent(job));

    expect(everywhere.remaining()).toEqual([other]);

    const scoped = setup([long, other, elsewhere], { jobIds: [job] });

    await scoped.run(invalidateEvent(job, { scope: "main" }));

    expect(scoped.remaining()).toEqual([other, elsewhere]);
  });

  test("skips snapshots that are already gone", async () => {
    const seeds = ["ci/main/a/k1", "ci/main/a/k2", "ci/main/a/k3"];
    let gone = "";

    const { run, remaining, idsByName } = setup(seeds, {
      wrapFetch: (inner) => {
        return (async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );

          if (url.pathname === `/v2/snapshots/${gone}`) {
            return new Response(
              JSON.stringify({
                errors: [
                  { code: "sandbox_snapshot_not_found", message: "gone" },
                ],
              }),
              {
                status: 404,
                headers: { "content-type": "application/json" },
              },
            );
          }

          return inner(input, init);
        }) as typeof fetch;
      },
    });

    gone = idsByName.get("ci/main/a/k2") ?? "";

    const result = await run(invalidateEvent("a"));

    expect(result.data).toMatchObject({ outcome: "invalidated", deleted: 2 });
    expect(remaining()).toEqual(["ci/main/a/k2"]);
  });

  test("rethrows other failures", async () => {
    const { run } = setup(["ci/main/a/k1"], {
      wrapFetch: (inner) => {
        return (async (input, init) => {
          const url = new URL(
            input instanceof Request ? input.url : String(input),
          );

          if (/^\/v2\/snapshots\/[^/]+$/.test(url.pathname)) {
            return new Response(
              JSON.stringify({ errors: [{ code: "boom", message: "boom" }] }),
              {
                status: 400,
                headers: { "content-type": "application/json" },
              },
            );
          }

          return inner(input, init);
        }) as typeof fetch;
      },
    });

    const result = await run(invalidateEvent("a"));

    expect(result.error).toBeDefined();
  });

  test("tells a job apart from one whose ID ends with its own", async () => {
    const seeds = ["ci/main/b/k1", "ci/main/a/b/k2", "ci/feature/x/b/k3"];

    const { run, remaining } = setup(seeds, { jobIds: ["b", "a/b"] });

    await run(invalidateEvent("b"));

    expect(remaining()).toEqual(["ci/main/a/b/k2"]);
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

  test("deletes only a PR scope or a run scope", async () => {
    const seeds = [
      "ci/pr:7/a/k1",
      "ci/pr:70/a/k2",
      "ci/run:abc/a/k3",
      "ci/run:abd/a/k4",
      "ci/main/a/k5",
    ];

    const pr = setup(seeds);

    await pr.run(invalidateEvent("a", { scope: "pr:7" }));

    expect(pr.remaining()).toEqual([
      "ci/pr:70/a/k2",
      "ci/run:abc/a/k3",
      "ci/run:abd/a/k4",
      "ci/main/a/k5",
    ]);

    const run = setup(seeds);

    await run.run(invalidateEvent("a", { scope: "run:abc" }));

    expect(run.remaining()).toEqual([
      "ci/pr:7/a/k1",
      "ci/pr:70/a/k2",
      "ci/run:abd/a/k4",
      "ci/main/a/k5",
    ]);
  });
});
