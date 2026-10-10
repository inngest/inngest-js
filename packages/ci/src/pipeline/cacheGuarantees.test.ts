/**
 * Tests of what the shared build function guarantees about cached snapshots:
 * within a pipeline run each base is built once, a chain of cached parents
 * builds each link without holding back the jobs that need an earlier link, a
 * snapshot about to expire is replaced, and a parent is looked up first and a
 * build invoked only on a miss. Across concurrent runs it is best-effort: runs
 * that miss at the same time may build redundantly, at most one snapshot keeps
 * the name and the others adopt it, so the results are correct. They run
 * against the fake Sandboxes API with snapshot names on.
 *
 * `runFunction` runs invokes beside the function. Its `concurrency` key limits
 * steps running at once, as it does on the platform, not runs, so runs that
 * miss together really do interleave.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { machineSetupScript } from "../machine/machine.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";

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
      return argv[2] !== machineSetupScript;
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
    return !line.includes(machineSetupScript);
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

    const lint = ci.job({ id: "lint", from: install }, async () => {
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

  test("runs that miss together may each build, and all end on the one snapshot that kept the name", async () => {
    const api = createFakeSandboxApi();

    // A slow install keeps every run's lookup ahead of any snapshot.
    api.script([{ match: "pnpm install", ticks: 5 }]);

    const results = await herd(api, 4);

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    // Best-effort across runs: they all missed, so more than one built.
    expect(count(api, "pnpm install")).toBeGreaterThan(1);
    expect(count(api, "pnpm lint")).toBe(4);

    // Yet one snapshot kept the name, nothing else is left behind, and every
    // run started from it.
    const [snapshot, ...others] = named(api);

    expect(others).toEqual([]);
    expect(api.snapshots.size).toBe(1);
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

    // Every build ran its commands, then lost the name to a snapshot of the
    // same name and took that one.
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

    const build = ci.job(
      { id: "build", from: install, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;
      },
    );

    const pack = ci.job(
      { id: "pack", from: build, cache: { key: "v1" } },
      async () => {
        await $`pnpm pack`;
      },
    );

    const startingFrom = (parent: typeof install, name: string) => {
      return ci.job({ id: name, from: parent }, async () => {
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
   *
   * Every poll is a step, and every step replays the pipeline, so the cost
   * grows with the ticks. Five outlast the other jobs' commands and keep the
   * run under a second, where forty took over two and hit the 5s timeout
   * under load.
   */
  const runSlowChain = async () => {
    const api = createFakeSandboxApi();

    api.script([
      { match: "pnpm build", ticks: 5 },
      { match: "pnpm pack", ticks: 5 },
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

  /** Both tests below read the same run, so it happens once. */
  let slowRun: ReturnType<typeof runSlowChain> | undefined;

  const slowChain = () => {
    slowRun ??= runSlowChain();

    return slowRun;
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

    const lint = ci.job({ id: "lint", from: install }, async () => {
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

    const lint = ci.job({ id: "lint", from: install }, async () => {
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

describe("jobs that start from one parent", () => {
  const siblings = (api: Api) => {
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const startingFrom = (name: string) => {
      return ci.job({ id: name, from: install }, async () => {
        await $`echo ${name}`;
      });
    };

    const a = startingFrom("a");
    const b = startingFrom("b");

    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all([a(), b()]);
    });
  };

  const buildSteps = (stepIds: string[]) => {
    return stepIds.filter((stepId) => {
      return stepId.endsWith("(from) › build");
    });
  };

  const lookups = (stepIds: string[]) => {
    return stepIds.filter((stepId) => {
      return stepId.endsWith("› lookup");
    });
  };

  test("the parent is looked up once, and one build serves both", async () => {
    const api = createFakeSandboxApi();

    const result = await runFunction(siblings(api), {
      event: prEvent,
      runId: "01COLD",
    });

    expect(result.type).toBe("function-resolved");

    expect(lookups(result.stepIds)).toEqual(["install (from) › lookup"]);

    expect(buildSteps(result.stepIds)).toEqual(["install (from) › build"]);
    expect(count(api, "pnpm install")).toBe(1);

    for (const job of ["a", "b"]) {
      const inJob = result.stepIds.filter((stepId) => {
        return result.spans[stepId]?.[0]?.id === job;
      });

      expect(inJob[0]).toBe(`${job} › machine`);
      expect(result.spans[`${job} › machine`]?.[0]?.name).toBe(job);
    }

    // Many jobs share the build, so it sits in none of them.
    expect(result.spans["install (from) › build"] ?? []).toEqual([]);
  });

  test("a warm hit invokes no build, and the parent is still looked up once", async () => {
    const api = createFakeSandboxApi();
    const pipeline = siblings(api);

    await runFunction(pipeline, { event: prEvent, runId: "01COLD" });

    const warm = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WARM",
    });

    expect(warm.type).toBe("function-resolved");
    expect(lookups(warm.stepIds)).toEqual(["install (from) › lookup"]);
    expect(buildSteps(warm.stepIds)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);
  });
});

describe("a snapshot older than the cache's maxAge", () => {
  const defineOldPipeline = (ci: ReturnType<typeof setup>["ci"]) => {
    const install = ci.job(
      { id: "install", cache: { key: "v1", maxAge: "1d" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const lint = ci.job({ id: "lint", from: install }, async () => {
      await $`pnpm lint`;
    });

    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });
  };

  test("is reused while it is younger", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup(api);
    const pipeline = defineOldPipeline(ci);

    await runFunction(pipeline, { event: prEvent, runId: "01FIRST" });

    const [holder] = named(api);

    (holder as { createdAt: string }).createdAt = new Date(
      Date.now() - 60 * 60 * 1000,
    ).toISOString();

    const second = await runFunction(pipeline, {
      event: prEvent,
      runId: "01SECOND",
    });

    expect(second.type).toBe("function-resolved");
    expect(count(api, "pnpm install")).toBe(1);
    expect(api.snapshots.has(holder?.id ?? "")).toBe(true);
  });

  test("is rebuilt, and the rebuild takes the name", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup(api);
    const pipeline = defineOldPipeline(ci);

    await runFunction(pipeline, { event: prEvent, runId: "01FIRST" });

    const [holder, ...others] = named(api);

    expect(others).toEqual([]);

    (holder as { createdAt: string }).createdAt = new Date(
      Date.now() - 2 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const second = await runFunction(pipeline, {
      event: prEvent,
      runId: "01SECOND",
    });

    expect(second.type).toBe("function-resolved");
    expect(count(api, "pnpm install")).toBe(2);
    expect(api.snapshots.has(holder?.id ?? "")).toBe(false);

    const [replacement, ...rest] = named(api);

    expect(rest).toEqual([]);
    expect(replacement?.id).not.toBe(holder?.id);
    expect(replacement?.name).toBe(holder?.name);
    expect(replacement?.status).toBe("READY");
  });

  test("a malformed maxAge throws when the job is defined", () => {
    const { ci } = setup(createFakeSandboxApi());

    expect(() => {
      return ci.job(
        { id: "install", cache: { key: "v1", maxAge: "a day" } },
        async () => {
          await $`pnpm install`;
        },
      );
    }).toThrow(/cache\.maxAge/);
  });

  test("a zero maxAge throws when the job is defined", () => {
    const { ci } = setup(createFakeSandboxApi());

    expect(() => {
      return ci.job(
        { id: "install", cache: { key: "v1", maxAge: "0s" } },
        async () => {},
      );
    }).toThrow(/cache\.maxAge/);
  });
});

describe("a job that starts from a job in its own app", () => {
  /**
   * `test` starts from `build`, which starts from `install`, each keyed on
   * the key given for it.
   */
  const chain = (api: Api, keys = { install: "v1", build: "v1" }) => {
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: keys.install } },
      async () => {
        await $`pnpm install`;
      },
    );

    const build = ci.job(
      { id: "build", from: install, cache: { key: keys.build } },
      async () => {
        await $`pnpm build`;
      },
    );

    const test = ci.job({ id: "test", from: build }, async () => {
      await $`pnpm test`;
    });

    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();
    });
  };

  /** The steps that invoke the build function. */
  const invokes = (stepIds: string[]) => {
    return stepIds.filter((stepId) => {
      return stepId.endsWith("› build");
    });
  };

  test("looks every link up before it invokes that link's build", async () => {
    const api = createFakeSandboxApi();

    const result = await runFunction(chain(api), {
      event: prEvent,
      runId: "01COLD",
    });

    expect(result.type).toBe("function-resolved");

    expect(invokes(result.stepIds)).toEqual([
      "install (from) › build",
      "build (from) › build",
    ]);

    const at = (stepId: string) => {
      return result.stepIds.indexOf(stepId);
    };

    // Each parent's key, lookup and build are steps of its own, whichever job
    // asked for it.
    for (const parent of ["install", "build"]) {
      expect(at(`${parent} (from) › cache:key`)).toBeGreaterThan(-1);
      expect(at(`${parent} (from) › lookup`)).toBeGreaterThan(-1);

      expect(at(`${parent} (from) › lookup`)).toBeLessThan(
        at(`${parent} (from) › build`),
      );
    }
  });

  test("a warm run still looks every link up, and invokes nothing", async () => {
    const api = createFakeSandboxApi();
    const pipeline = chain(api);

    await runFunction(pipeline, { event: prEvent, runId: "01COLD" });

    const warm = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WARM",
    });

    expect(warm.type).toBe("function-resolved");
    expect(warm.stepIds).toContain("install (from) › cache:key");
    expect(warm.stepIds).toContain("install (from) › lookup");
    expect(warm.stepIds).toContain("build (from) › lookup");
    expect(invokes(warm.stepIds)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm build")).toBe(1);
    expect(count(api, "pnpm test")).toBe(2);
  });

  test("a parent whose key changed is a miss, and only it is built again", async () => {
    const api = createFakeSandboxApi();

    await runFunction(chain(api), { event: prEvent, runId: "01COLD" });

    const changed = await runFunction(
      chain(api, { install: "v1", build: "v2" }),
      { event: prEvent, runId: "01CHANGED" },
    );

    expect(changed.type).toBe("function-resolved");
    expect(invokes(changed.stepIds)).toEqual(["build (from) › build"]);
    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm build")).toBe(2);
  });

  test("a change further up the chain is a miss for every link after it", async () => {
    const api = createFakeSandboxApi();

    await runFunction(chain(api), { event: prEvent, runId: "01COLD" });

    // `build`'s own key is the same, but its name holds the snapshot it
    // starts from, and that's a new one.
    const changed = await runFunction(
      chain(api, { install: "v2", build: "v1" }),
      { event: prEvent, runId: "01CHANGED" },
    );

    expect(changed.type).toBe("function-resolved");

    expect(invokes(changed.stepIds)).toEqual([
      "install (from) › build",
      "build (from) › build",
    ]);

    expect(count(api, "pnpm install")).toBe(2);
    expect(count(api, "pnpm build")).toBe(2);
  });

  test("a parent snapshot still being written is waited for, not built again", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const lint = ci.job({ id: "lint", from: install }, async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await lint();
    });

    await runFunction(pipeline, { event: prEvent, runId: "01FIRST" });

    const [snapshot] = named(api);

    Object.assign(snapshot ?? {}, { status: "CREATING", readyAfterGets: 1 });

    const second = await runFunction(pipeline, {
      event: prEvent,
      runId: "01SECOND",
    });

    expect(second.type).toBe("function-resolved");
    expect(invokes(second.stepIds)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);

    const child = [...api.sandboxes.values()].find((machine) => {
      return machine.name === "ci-01SECOND-lint";
    });

    expect(child?.snapshotId).toBe(snapshot?.id);
  });

  test("runs that all miss each invoke, and all end on one snapshot per link", async () => {
    const api = createFakeSandboxApi();
    const pipeline = chain(api);

    const results = await Promise.all(
      ["01A", "01B", "01C"].map((runId) => {
        return runFunction(pipeline, { event: prEvent, runId });
      }),
    );

    for (const result of results) {
      expect(result.type).toBe("function-resolved");

      expect(invokes(result.stepIds)).toEqual([
        "install (from) › build",
        "build (from) › build",
      ]);
    }

    // Which run built is up to timing, and runs that miss together may each
    // build. What is fixed is that each link keeps one snapshot, and every
    // run's `test` started from the `build` one.
    expect(count(api, "pnpm test")).toBe(3);

    const snapshots = named(api);

    expect(snapshots).toHaveLength(2);

    for (const snapshot of snapshots) {
      expect(snapshot.status).toBe("READY");
    }

    const buildSnapshot = snapshots.find((snapshot) => {
      return snapshot.name?.includes("/build/");
    });

    expect(buildSnapshot).toBeDefined();

    const testMachines = [...api.sandboxes.values()].filter((machine) => {
      return machine.name.endsWith("-test");
    });

    expect(testMachines).toHaveLength(3);

    for (const machine of testMachines) {
      expect(machine.snapshotId).toBe(buildSnapshot?.id);
    }
  });
});

describe("a parent that several jobs need in one pipeline run", () => {
  /** The steps that invoke the build function. */
  const invokes = (stepIds: string[]) => {
    return stepIds
      .filter((stepId) => {
        return stepId.endsWith("› build");
      })
      .sort();
  };

  /**
   * `test` starts from `build`, which starts from `install`, and `lint`
   * starts from `install` too: `install` is both a parent's parent and a
   * parent. The pipeline asks for the jobs in `order`, all at once or each
   * after the one before.
   */
  const diamond = (api: Api, order: ("test" | "lint")[], inTurn = false) => {
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const build = ci.job(
      { id: "build", from: install, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;
      },
    );

    const jobs = {
      test: ci.job({ id: "test", from: build }, async () => {
        await $`pnpm test`;
      }),
      lint: ci.job({ id: "lint", from: install }, async () => {
        await $`pnpm lint`;
      }),
    };

    return ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      if (inTurn) {
        for (const name of order) {
          await jobs[name]();
        }

        return;
      }

      await Promise.all(
        order.map((name) => {
          return jobs[name]();
        }),
      );
    });
  };

  test("a parent that is also a parent's parent is built by one invoke", async () => {
    const api = createFakeSandboxApi();

    const result = await runFunction(diamond(api, ["test", "lint"]), {
      event: prEvent,
    });

    expect(result.type).toBe("function-resolved");

    expect(invokes(result.stepIds)).toEqual([
      "build (from) › build",
      "install (from) › build",
    ]);

    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm build")).toBe(1);
    expect(named(api)).toHaveLength(2);
  });

  test("the steps planned don't depend on which job asks first", async () => {
    const testFirst = await runFunction(
      diamond(createFakeSandboxApi(), ["test", "lint"], true),
      { event: prEvent },
    );

    const lintFirst = await runFunction(
      diamond(createFakeSandboxApi(), ["lint", "test"], true),
      { event: prEvent },
    );

    expect(lintFirst.type).toBe("function-resolved");
    expect(lintFirst.stepIds.sort()).toEqual(testFirst.stepIds.sort());
  });

  test("three jobs that start together from one parent share one invoke", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const build = ci.job(
      { id: "build", from: install, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;
      },
    );

    const startingFrom = (name: string) => {
      return ci.job({ id: name, from: build }, async () => {
        await $`echo ${name}`;
      });
    };

    const children = ["a", "b", "c"].map(startingFrom);

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await Promise.all(
        children.map((child) => {
          return child();
        }),
      );
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(invokes(result.stepIds)).toEqual([
      "build (from) › build",
      "install (from) › build",
    ]);

    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm build")).toBe(1);
  });

  test("a job later in the run reuses the build an earlier one resolved", async () => {
    const api = createFakeSandboxApi();
    const { ci } = setup(api);

    const install = ci.job(
      { id: "install", cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );

    const build = ci.job(
      { id: "build", from: install, cache: { key: "v1" } },
      async () => {
        await $`pnpm build`;
      },
    );

    const test = ci.job({ id: "test", from: build }, async () => {
      await $`pnpm test`;
    });

    const lint = ci.job({ id: "lint", from: install }, async () => {
      await $`pnpm lint`;
    });

    const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
      await test();
      await lint();
    });

    const result = await runFunction(pipeline, { event: prEvent });

    expect(result.type).toBe("function-resolved");

    expect(invokes(result.stepIds)).toEqual([
      "build (from) › build",
      "install (from) › build",
    ]);

    expect(count(api, "pnpm install")).toBe(1);
    expect(count(api, "pnpm lint")).toBe(1);
  });
});
