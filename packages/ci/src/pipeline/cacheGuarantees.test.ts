/**
 * Tests of what the shared build function guarantees about cached snapshots:
 * a burst of runs builds a snapshot once, a chain of cached parents builds
 * each link once without holding back the jobs that need an earlier link, and
 * a snapshot about to expire is replaced. They run against the fake Sandboxes
 * API with snapshot names on.
 *
 * `runFunction` runs invokes beside the function and makes runs of one
 * `event.data` concurrency key take turns, as the platform does for the build
 * function's `cacheKey` limit, so these tests see real interleaving.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { from } from "../machine/from.ts";
import { machineSetupScript } from "../machine/machine.ts";
import { writeSnapshotMetaScript } from "../machine/snapshotMeta.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";

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

type Api = ReturnType<typeof createFakeSandboxApi>;

const setup = (api: Api) => {
  const client = createCiTestClient(api);

  const ci = createCi(client, {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  return { ci };
};

/** What jobs asked machines to run, as `argv` joined, in the order they started. */
const ran = (api: Api): string[] => {
  return api.commands
    .filter((argv) => {
      return (
        argv[2] !== machineSetupScript && argv[2] !== writeSnapshotMetaScript
      );
    })
    .map((argv) => {
      return argv.join(" ");
    });
};

/**
 * What happened on machines, in order: each user command as it started, and
 * each snapshot of a machine as it was taken.
 */
const events = (api: Api): string[] => {
  return api.timeline.filter((line) => {
    return (
      !line.includes(machineSetupScript) &&
      !line.includes(writeSnapshotMetaScript)
    );
  });
};

const count = (api: Api, command: string): number => {
  return ran(api).filter((line) => {
    return line === command;
  }).length;
};

/** The snapshots that hold a name, READY or not. */
const named = (api: Api) => {
  return [...api.snapshots.values()].filter((snapshot) => {
    return snapshot.name;
  });
};

describe("a burst of runs that need one cached job", () => {
  const herd = (api: Api, runs: number) => {
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const lint = ci.job("lint", async () => {
      await from(install);

      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    return Promise.all(
      Array.from({ length: runs }, (_, i) => {
        return runFunction(pipeline, {
          event: prEvent,
          runId: `01HERD${i}`,
        });
      }),
    );
  };

  /** The snapshot each run's `lint` machine started from. */
  const startedFrom = (api: Api): (string | undefined)[] => {
    return [...api.sandboxes.values()]
      .filter((machine) => {
        return machine.name.endsWith("-lint");
      })
      .map((machine) => {
        return machine.snapshotId;
      });
  };

  test("builds it once and every run reuses that snapshot", async () => {
    const api = createFakeSandboxApi();
    const results = await herd(api, 4);

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm lint")).toBe(4);

    const [snapshot, ...others] = named(api);

    expect(others).toEqual([]);
    expect(snapshot?.status).toBe("READY");

    expect(startedFrom(api)).toEqual([
      snapshot?.id,
      snapshot?.id,
      snapshot?.id,
      snapshot?.id,
    ]);
  });

  test("a build that loses the name with a 409 adopts the winner's snapshot, and so does everyone else", async () => {
    const api = createFakeSandboxApi();

    api.loseSnapshotNameRaces();

    const results = await herd(api, 4);

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    // The one build ran its commands, then lost the name to a snapshot of the
    // same name and took that one. The runs behind it found the winner.
    expect(count(api, "pnpm install")).toBe(1);

    const [winner, ...others] = [...api.snapshots.values()];

    expect(others).toEqual([]);
    expect(winner?.name).toMatch(/^ci\/pr:7\/install\//);
    expect(winner?.status).toBe("READY");

    expect(startedFrom(api)).toEqual([
      winner?.id,
      winner?.id,
      winner?.id,
      winner?.id,
    ]);
  });
});

describe("a chain of cached jobs", () => {
  const chain = (api: Api) => {
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const build = ci.job({ id: "build", cache: { key: "v1" } }, async () => {
      await from(install);

      await $`pnpm build`;
    });

    const pack = ci.job({ id: "pack", cache: { key: "v1" } }, async () => {
      await from(build);

      await $`pnpm pack`;
    });

    const startingFrom = (parent: typeof install, name: string) => {
      return ci.job(name, async () => {
        await from(parent);

        await $`echo ${name}`;
      });
    };

    const a = [startingFrom(install, "a1"), startingFrom(install, "a2")];
    const b = [startingFrom(build, "b1"), startingFrom(build, "b2")];
    const c = [startingFrom(pack, "c1"), startingFrom(pack, "c2")];

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all(
        [...c, ...b, ...a].map((job) => {
          return job();
        }),
      );
    });

    return runFunction(pipeline, { event: prEvent });
  };

  test("runs each link's commands once, and the jobs after them", async () => {
    const api = createFakeSandboxApi();
    const result = await chain(api);

    expect(result.type).toBe("function-resolved");

    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm build")).toBe(1);
    expect(count(api, "pnpm pack")).toBe(1);

    for (const name of ["a1", "a2", "b1", "b2", "c1", "c2"]) {
      expect(count(api, `echo ${name}`)).toBe(1);
    }

    expect(named(api)).toHaveLength(3);
  });

  /**
   * A chain whose build and pack take a while, as polls
   * of their processes, so a job that waited for either would show it. Gives
   * where events fall in the timeline.
   */
  const slowChain = async () => {
    const api = createFakeSandboxApi();

    api.script([
      { match: "pnpm build", ticks: 40 },
      { match: "pnpm pack", ticks: 40 },
    ]);

    const result = await chain(api);

    expect(result.type).toBe("function-resolved");

    const order = events(api);

    return {
      command: (line: string) => {
        return order.indexOf(`command ${line}`);
      },
      /** When the snapshot of a job's build run was taken. */
      snapshot: (job: string) => {
        return order.findIndex((event) => {
          return event.startsWith("snapshot ") && event.endsWith(`-${job}`);
        });
      },
    };
  };

  test("jobs that start from install don't wait for build or pack", async () => {
    const at = await slowChain();

    // The harness runs each build beside the pipeline, and calls the pipeline
    // again as soon as one ends, so an event's place in the timeline is when it
    // happened. The pipeline asks for pack's jobs first, then build's, then
    // install's, yet install's jobs run their commands while build and pack
    // are still running theirs.
    expect(at.snapshot("install")).toBeGreaterThan(-1);
    expect(at.command("echo a1")).toBeGreaterThan(at.snapshot("install"));
    expect(at.command("echo a2")).toBeGreaterThan(at.snapshot("install"));
    expect(at.command("echo a1")).toBeLessThan(at.snapshot("build"));
    expect(at.command("echo a2")).toBeLessThan(at.snapshot("build"));
    expect(at.command("echo a1")).toBeLessThan(at.snapshot("pack"));
  });

  test("jobs that start from build don't wait for pack", async () => {
    const at = await slowChain();

    expect(at.snapshot("build")).toBeGreaterThan(-1);
    expect(at.command("echo b1")).toBeGreaterThan(at.snapshot("build"));
    expect(at.command("echo b1")).toBeLessThan(at.snapshot("pack"));
    expect(at.command("echo b2")).toBeLessThan(at.snapshot("pack"));
  });
});

describe("a warm cache", () => {
  test("is read by the caller, with no build run and no place in the queue", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const lint = ci.job("lint", async () => {
      await from(install);

      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    const builds = () => {
      return [...api.sandboxes.values()].filter((machine) => {
        return machine.name.startsWith("ci-01TESTINVOKED");
      }).length;
    };

    const cold = await runFunction(pipeline, {
      event: prEvent,
      runId: "01COLD",
    });

    expect(cold.stepIds).toContain("install (from) › lookup");
    expect(cold.stepIds).toContain("install (from) › build");
    expect(builds()).toBe(1);

    const warm = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WARM",
    });

    expect(warm.type).toBe("function-resolved");
    expect(warm.stepIds).toContain("install (from) › lookup");
    expect(warm.stepIds).not.toContain("install (from) › build");
    expect(builds()).toBe(1);
    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm lint")).toBe(2);
  });
});

describe("a snapshot that is about to expire", () => {
  test("is rebuilt rather than reused, and its replacement takes the name", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const lint = ci.job("lint", async () => {
      await from(install);

      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    const first = await runFunction(pipeline, {
      event: prEvent,
      runId: "01FIRST",
    });

    expect(first.type).toBe("function-resolved");

    const [holder, ...others] = named(api);

    expect(others).toEqual([]);

    // Inside the 15 minute margin.
    (holder as { expiresAt: string }).expiresAt = new Date(
      Date.now() + 5 * 60 * 1000,
    ).toISOString();

    const second = await runFunction(pipeline, {
      event: prEvent,
      runId: "01SECOND",
    });

    expect(second.type).toBe("function-resolved");
    expect(count(api, "pnpm install")).toBe(2);

    // The expiring holder is deleted, and the rebuild has the name.
    expect(api.snapshots.has(holder?.id ?? "")).toBe(false);

    const [replacement, ...rest] = named(api);

    expect(rest).toEqual([]);
    expect(replacement?.id).not.toBe(holder?.id);
    expect(replacement?.name).toBe(holder?.name);
    expect(replacement?.status).toBe("READY");

    const child = [...api.sandboxes.values()].find((machine) => {
      return machine.name === "ci-01SECOND-lint";
    });

    expect(child?.snapshotId).toBe(replacement?.id);
  });
});
