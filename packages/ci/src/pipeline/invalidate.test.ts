/**
 * Tests of invalidating a job's cached images: every scope or one, jobs whose
 * IDs share a prefix, and an app that doesn't define the job. They seed named
 * snapshots in the fake Sandboxes API and run the generated function.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";
import { invalidateEvent } from "./invalidate.ts";

const setup = (names: string[]) => {
  const api = createFakeSandboxApi();
  const client = createCiTestClient(api);

  const ci = createCi(client, {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  const a = ci.job("a", async () => undefined);

  ci.job("ab", async () => undefined);

  const invalidate = ci.functions().find((fn) => {
    return fn.opts.id === "ci/invalidate";
  });

  for (const name of names) {
    const id = crypto.randomUUID();

    api.snapshots.set(id, {
      id,
      name,
      status: "READY",
      sandboxId: "sbx",
      files: new Map(),
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

  return { a, run, remaining };
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
    const { a, run, remaining } = setup(names);

    const result = await run(invalidateEvent(a));

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
});
