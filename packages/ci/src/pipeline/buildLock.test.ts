/**
 * Tests of the build lock (`dedupeBuilds: "name-lock"`): concurrent runs that
 * miss the same cached job build it once, and the rest adopt its snapshot.
 * They run against the fake Sandboxes API, which holds a machine's name for as
 * long as the machine lives, gives the same machine back for the same name and
 * settings, and refuses the name to a machine with other settings.
 *
 * @module
 */

import type { InngestFunction } from "inngest";
import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { machineSetupScript } from "../machine/machine.ts";
import { createCiTestClient } from "../testing/client.ts";
import { EventBus } from "../testing/eventBus.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { buildDoneEvent, buildLockName } from "./buildLock.ts";
import { createCi } from "./createCi.ts";

type Api = ReturnType<typeof createFakeSandboxApi>;

const setup = (
  api: Api,
  options: { app?: string; lock?: boolean; bus?: EventBus } = {},
) => {
  const bus = options.bus ?? new EventBus();
  const client = createCiTestClient(api, options.app, bus);

  const ci = createCi(client, {
    github: consoleReporter(),
    ...(options.lock === false ? {} : { dedupeBuilds: "name-lock" as const }),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
  });

  const install = ci.job({ id: "install", cache: { key: "v1" } }, async () => {
    await $`pnpm install`;
  });

  const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
    await install();
  });

  return { ci, pipeline, bus };
};

const count = (api: Api, command: string): number => {
  return api.commands.filter((argv) => {
    return argv[2] !== machineSetupScript && argv.join(" ") === command;
  }).length;
};

/** The snapshots that hold a name. */
const named = (api: Api) => {
  return [...api.snapshots.values()].filter((snapshot) => {
    return snapshot.name;
  });
};

/** The machines that hold a build lock's name, ended or not. */
const lockMachines = (api: Api) => {
  return [...api.sandboxes.values()].filter((machine) => {
    return machine.name.startsWith("ci-build-");
  });
};

const heldLocks = (api: Api) => {
  return lockMachines(api).filter((machine) => {
    return machine.status !== "TERMINATED";
  });
};

const runs = (
  pipeline: InngestFunction.Any,
  count: number,
  options: Parameters<typeof runFunction>[1] = {},
) => {
  return Promise.all(
    Array.from({ length: count }, (_, i) => {
      return runFunction(pipeline, {
        event: prEvent,
        runId: `01LOCK${i}`,
        ...options,
      });
    }),
  );
};

/** Run once and clear the fake, to learn the lock's name and start clean. */
const learnLockName = async (
  api: Api,
): Promise<{
  cacheKey: string;
  snapshot: ReturnType<typeof named>[number] | undefined;
}> => {
  const { pipeline, bus } = setup(api);

  await runFunction(pipeline, {
    bus,
    event: prEvent,
    runId: "01LEARN",
  });

  const [snapshot] = named(api);

  api.snapshots.clear();
  api.sandboxes.clear();
  api.commands.length = 0;

  return { cacheKey: snapshot?.name ?? "", snapshot };
};

/** A build lock held by a run that has since died. */
const plantLock = (api: Api, cacheKey: string, owner: string): string => {
  const id = "99999999-9999-4999-8999-000000000001";

  api.sandboxes.set(id, {
    id,
    name: buildLockName(cacheKey),
    status: "RUNNING",
    vcpu: 2,
    memoryMb: 2048,
    environment: { OWNER: owner },
  });

  return id;
};

describe("runs that miss the same cached job together", () => {
  test("one builds, the rest adopt its snapshot, and nothing holds the lock afterwards", async () => {
    const api = createFakeSandboxApi();

    // A slow install keeps every run's lookup ahead of any snapshot.
    api.script([{ match: "pnpm install", ticks: 5 }]);

    const { pipeline, bus } = setup(api);
    const results = await runs(pipeline, 4, { bus });

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    expect(count(api, "pnpm install")).toBe(1);

    const [snapshot, ...others] = named(api);

    expect(others).toEqual([]);
    expect(snapshot?.status).toBe("READY");
    expect(api.snapshots.size).toBe(1);

    expect(lockMachines(api)).toHaveLength(1);
    expect(heldLocks(api)).toEqual([]);
  });

  test("without the option, they each build and no lock is taken", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", ticks: 5 }]);

    const { pipeline, bus } = setup(api, { lock: false });

    await runs(pipeline, 3, { bus });

    expect(count(api, "pnpm install")).toBeGreaterThan(1);
    expect(lockMachines(api)).toEqual([]);
  });

  test("a lock holder's machine is owned by its build run", async () => {
    const api = createFakeSandboxApi();
    const { pipeline, bus } = setup(api);

    await runFunction(pipeline, {
      bus,
      event: prEvent,
      runId: "01OWNED",
    });

    const [lock] = lockMachines(api);

    expect(lock?.environment?.OWNER).toMatch(/^01TESTINVOKED/);
  });

  test("apps with the same job and key don't block each other", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", ticks: 5 }]);

    const bus = new EventBus();
    const a = setup(api, { app: "app-a", bus });
    const b = setup(api, { app: "app-b", bus });

    const results = await Promise.all([
      runFunction(a.pipeline, { bus, event: prEvent, runId: "01APPA" }),
      runFunction(b.pipeline, { bus, event: prEvent, runId: "01APPB" }),
    ]);

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    // Two names, so two builds at once and two locks.
    expect(count(api, "pnpm install")).toBe(2);
    expect(new Set(lockMachines(api).map((lock) => lock.name)).size).toBe(2);
    expect(heldLocks(api)).toEqual([]);
  });

  test("repositories with the same job and key don't block each other", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", ticks: 5 }]);

    const { pipeline, bus } = setup(api);

    const other = {
      ...prEvent,
      data: {
        ...prEvent.data,
        repository: { full_name: "inngest/other" },
        pull_request: {
          ...prEvent.data.pull_request,
          head: {
            ...prEvent.data.pull_request.head,
            repo: { full_name: "inngest/other" },
          },
        },
      },
    };

    await Promise.all([
      runFunction(pipeline, {
        bus,
        event: prEvent,
        runId: "01REPOA",
      }),
      runFunction(pipeline, {
        bus,
        event: other,
        runId: "01REPOB",
      }),
    ]);

    expect(count(api, "pnpm install")).toBe(2);
    expect(new Set(lockMachines(api).map((lock) => lock.name)).size).toBe(2);
  });
});

describe("a build that fails", () => {
  test("lets go of the lock, so the next run builds", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", exitCode: 1 }]);

    const { pipeline, bus } = setup(api);

    const failed = await runFunction(pipeline, {
      bus,
      event: prEvent,
      runId: "01FAILED",
    });

    expect(failed.type).toBe("function-rejected");
    expect(heldLocks(api)).toEqual([]);

    api.script([]);

    const next = await runFunction(pipeline, {
      bus,
      event: prEvent,
      runId: "01AFTER",
    });

    expect(next.type).toBe("function-resolved");
    expect(count(api, "pnpm install")).toBe(2);
    expect(named(api)).toHaveLength(1);
  });

  test("when snapshots are unavailable still lets go, and waiting runs build in turn", async () => {
    const api = createFakeSandboxApi();

    api.disableSnapshots();
    api.script([{ match: "pnpm install", ticks: 3 }]);

    const { pipeline, bus } = setup(api);
    const results = await runs(pipeline, 3, { bus });

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    // No snapshot ever appears for the others to adopt, so each builds once it
    // holds the lock.
    expect(count(api, "pnpm install")).toBe(3);
    expect(heldLocks(api)).toEqual([]);
  });
});

/** Wait for the event loop to let every pending promise run. */
const settleLoop = (): Promise<void> => {
  return new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
};

const timeouts = (bus: EventBus) => {
  return bus.saved.filter((pause) => {
    return pause.ended === "timeout";
  });
};

const doneEvents = (bus: EventBus) => {
  return bus.sent.filter((event) => {
    return event.name === buildDoneEvent;
  });
};

describe("runs that wait are woken, not polling", () => {
  test("a herd waits on one event, with no wait running out", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", ticks: 5 }]);

    const { pipeline, bus } = setup(api);
    const results = await runs(pipeline, 4, { bus });

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    expect(count(api, "pnpm install")).toBe(1);
    expect(heldLocks(api)).toEqual([]);

    // The winner sent once; the losers were woken by it and sent nothing.
    expect(doneEvents(bus)).toHaveLength(1);
    expect(doneEvents(bus)[0]?.data.status).toBe("ready");
    expect(timeouts(bus)).toEqual([]);

    // Every wait was saved before the event that ended it was sent, and it
    // names the lock it waits on.
    for (const pause of bus.saved) {
      expect(pause.expression).toMatch(/^async\.data\.name == 'ci-build-/);
      expect(pause.ended).toBe("matched");
    }

    // The losers' stepped through no sleeps.
    for (const result of results) {
      expect(result.stepIds.join("\n")).not.toContain("lock:wait");
    }
  });

  test("a wait saved after the event is not woken by it (no lookback), so it times out and looks again", async () => {
    const api = createFakeSandboxApi();
    const { cacheKey } = await learnLockName(api);
    const id = plantLock(api, cacheKey, "01DEAD");
    const { pipeline, bus } = setup(api);

    // The holder let go, and said so, before this run saved its wait.
    bus.send({
      name: buildDoneEvent,
      data: { name: buildLockName(cacheKey), status: "failed" },
    });

    const result = await runFunction(pipeline, {
      bus,
      event: prEvent,
      runId: "01LATE",
      // The platform reclaims the dead holder's machine after the wait ran out.
      beforeRequest: () => {
        if (timeouts(bus).length >= 1) {
          const stale = api.sandboxes.get(id);

          if (stale) {
            stale.status = "TERMINATED";
          }
        }
      },
    });

    expect(result.type).toBe("function-resolved");
    expect(timeouts(bus)).toHaveLength(1);
    expect(count(api, "pnpm install")).toBe(1);
  });

  test("a holder that finished its snapshot but never let go is found by the look after a refused claim", async () => {
    const api = createFakeSandboxApi();
    const { cacheKey, snapshot } = await learnLockName(api);

    plantLock(api, cacheKey, "01DEAD");

    const { pipeline, bus } = setup(api);
    let planted = false;

    const result = await runFunction(pipeline, {
      bus,
      event: prEvent,
      runId: "01FOUND",
      // The snapshot appears after the run's first look, as the holder takes
      // it, and nothing is ever sent.
      beforeRequest: () => {
        if (!planted && bus.saved.length > 0 && snapshot) {
          planted = true;

          api.snapshots.set(snapshot.id, snapshot);
        }
      },
    });

    expect(result.type).toBe("function-resolved");
    expect(count(api, "pnpm install")).toBe(0);
    expect(timeouts(bus)).toEqual([]);

    // It said so, so the wait it left open is ended and the run can end.
    expect(doneEvents(bus)).toHaveLength(1);
  });

  test("a build that fails wakes the waiting runs, who claim the lock in turn", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", exitCode: 1, ticks: 5 }]);

    const { pipeline, bus } = setup(api);
    const results = await runs(pipeline, 3, { bus });

    // Nothing to adopt, so each builds, and fails, once it holds the lock.
    expect(count(api, "pnpm install")).toBe(3);

    for (const result of results) {
      expect(result.type).toBe("function-rejected");
    }

    expect(
      doneEvents(bus).map((event) => {
        return event.data.status;
      }),
    ).toEqual(["failed", "failed", "failed"]);

    expect(timeouts(bus)).toEqual([]);
    expect(heldLocks(api)).toEqual([]);
  });

  test("a failure then a pass: the first waiter to claim builds, and the rest adopt it", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", exitCode: 1, ticks: 5 }]);

    const { pipeline, bus } = setup(api);

    const results = await runs(pipeline, 3, {
      bus,
      beforeRequest: () => {
        // The first build has failed, so a later one passes.
        if (doneEvents(bus).length > 0) {
          api.script([]);
        }
      },
    });

    const outcomes = results.map((result) => {
      return result.type;
    });

    expect(
      outcomes.filter((type) => type === "function-rejected"),
    ).toHaveLength(1);
    expect(
      outcomes.filter((type) => type === "function-resolved"),
    ).toHaveLength(2);

    expect(count(api, "pnpm install")).toBe(2);
    expect(named(api)).toHaveLength(1);
    expect(timeouts(bus)).toEqual([]);
    expect(heldLocks(api)).toEqual([]);
  });

  test("runs replay to the same steps: the wait and the send are memoized", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", ticks: 3 }]);

    const { pipeline, bus } = setup(api);
    const results = await runs(pipeline, 3, { bus });

    for (const result of results) {
      const ids = result.stepIds;

      expect(new Set(ids).size).toBe(ids.length);
    }

    expect(doneEvents(bus)).toHaveLength(1);
  });
});

describe("a build that died holding the lock", () => {
  const failedEvent = (cacheKey: string, owner: string) => {
    return {
      name: "inngest/function.failed",
      data: {
        function_id: "ci-test-ci/build",
        run_id: owner,
        event: { data: { cacheKey } },
      },
    };
  };

  const cleanupOf = (ci: ReturnType<typeof setup>["ci"]) => {
    const cleanup = ci.functions().find((fn) => {
      // biome-ignore lint/suspicious/noExplicitAny: reading the function's options
      return (fn as any).opts.id === "ci/build/cleanup";
    });

    if (!cleanup) {
      throw new Error("no cleanup function for the build");
    }

    return cleanup;
  };

  test("the cleanup function releases it and wakes a waiting run, which then builds", async () => {
    const api = createFakeSandboxApi();
    const { cacheKey } = await learnLockName(api);

    plantLock(api, cacheKey, "01DEAD");

    const { ci, pipeline, bus } = setup(api);

    // The test sends the cleanup, so it counts as a run that may still act.
    bus.enter();

    const waiter = runFunction(pipeline, {
      bus,
      event: prEvent,
      runId: "01WAITER",
    });

    while (bus.saved.length === 0) {
      await settleLoop();
    }

    await settleLoop();

    expect(count(api, "pnpm install")).toBe(0);

    await runFunction(cleanupOf(ci), {
      bus,
      event: failedEvent(cacheKey, "01DEAD"),
    });

    bus.leave();

    const result = await waiter;

    expect(result.type).toBe("function-resolved");
    expect(timeouts(bus)).toEqual([]);
    expect(count(api, "pnpm install")).toBe(1);
    expect(heldLocks(api)).toEqual([]);
    expect(named(api)).toHaveLength(1);
  });

  test("the cleanup function leaves a lock that another run holds now", async () => {
    const api = createFakeSandboxApi();
    const { cacheKey } = await learnLockName(api);

    const id = plantLock(api, cacheKey, "01NEWER");
    const { ci, bus } = setup(api);

    await runFunction(cleanupOf(ci), {
      bus,
      event: failedEvent(cacheKey, "01DEAD"),
    });

    expect(api.sandboxes.get(id)?.status).toBe("RUNNING");
  });

  test("the platform reclaiming the machine releases it too: the wait runs out and the run claims", async () => {
    const api = createFakeSandboxApi();
    const { cacheKey } = await learnLockName(api);

    const id = plantLock(api, cacheKey, "01DEAD");
    const { pipeline, bus } = setup(api);

    const result = await runFunction(pipeline, {
      bus,
      event: prEvent,
      runId: "01WAITER",
      beforeRequest: () => {
        // The longest a build may run has passed.
        if (timeouts(bus).length >= 2) {
          const stale = api.sandboxes.get(id);

          if (stale) {
            stale.status = "TERMINATED";
          }
        }
      },
    });

    expect(result.type).toBe("function-resolved");
    expect(timeouts(bus).length).toBeGreaterThanOrEqual(2);
    expect(count(api, "pnpm install")).toBe(1);
  });

  test("a lock that never lets go is built without after a while", async () => {
    const api = createFakeSandboxApi();
    const { cacheKey } = await learnLockName(api);

    const id = plantLock(api, cacheKey, "01DEAD");
    const { pipeline, bus } = setup(api);

    const result = await runFunction(pipeline, {
      bus,
      event: prEvent,
      runId: "01IMPATIENT",
      maxRequests: 2000,
    });

    expect(result.type).toBe("function-resolved");
    expect(count(api, "pnpm install")).toBe(1);
    expect(api.sandboxes.get(id)?.status).toBe("RUNNING");
    expect(timeouts(bus).length).toBeGreaterThanOrEqual(10);
  }, 60_000);
});

describe("the fake's name rules, as the real API behaves", () => {
  const create = async (api: Api, environment: Record<string, string>) => {
    const response = await api.fetch("http://sandboxes.test/v2/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "x",
        vcpu: 1,
        memoryMb: 512,
        environment,
      }),
    });

    return {
      status: response.status,
      body: (await response.json()) as {
        data?: { id: string };
        errors?: { code: string }[];
      },
    };
  };

  test("the same name and settings give the same machine back, other settings are refused, and ending the machine frees the name", async () => {
    const api = createFakeSandboxApi();

    const first = await create(api, { OWNER: "a" });
    const again = await create(api, { OWNER: "a" });
    const other = await create(api, { OWNER: "b" });

    expect(first.status).toBe(201);
    expect(again.body.data?.id).toBe(first.body.data?.id);
    expect(other.status).toBe(409);
    expect(other.body.errors?.[0]?.code).toBe("sandbox_name_taken");

    await api.fetch(
      `http://sandboxes.test/v2/sandboxes/${first.body.data?.id}`,
      { method: "DELETE" },
    );

    const next = await create(api, { OWNER: "b" });

    expect(next.status).toBe(201);
    expect(next.body.data?.id).not.toBe(first.body.data?.id);
  });
});
