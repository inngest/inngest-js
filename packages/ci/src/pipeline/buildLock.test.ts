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
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { buildLockName } from "./buildLock.ts";
import { createCi } from "./createCi.ts";

type Api = ReturnType<typeof createFakeSandboxApi>;

const setup = (api: Api, options: { app?: string; lock?: boolean } = {}) => {
  const client = createCiTestClient(api, options.app);

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

  return { ci, pipeline };
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
const learnLockName = async (api: Api): Promise<string> => {
  const { pipeline } = setup(api);

  await runFunction(pipeline, { event: prEvent, runId: "01LEARN" });

  const [snapshot] = named(api);

  api.snapshots.clear();
  api.sandboxes.clear();
  api.commands.length = 0;

  return snapshot?.name ?? "";
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

    const { pipeline } = setup(api);
    const results = await runs(pipeline, 4);

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

    const { pipeline } = setup(api, { lock: false });

    await runs(pipeline, 3);

    expect(count(api, "pnpm install")).toBeGreaterThan(1);
    expect(lockMachines(api)).toEqual([]);
  });

  test("a lock holder's machine is owned by its build run", async () => {
    const api = createFakeSandboxApi();
    const { pipeline } = setup(api);

    await runFunction(pipeline, { event: prEvent, runId: "01OWNED" });

    const [lock] = lockMachines(api);

    expect(lock?.environment?.OWNER).toMatch(/^01TESTINVOKED/);
  });

  test("apps with the same job and key don't block each other", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", ticks: 5 }]);

    const a = setup(api, { app: "app-a" });
    const b = setup(api, { app: "app-b" });

    const results = await Promise.all([
      runFunction(a.pipeline, { event: prEvent, runId: "01APPA" }),
      runFunction(b.pipeline, { event: prEvent, runId: "01APPB" }),
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

    const { pipeline } = setup(api);

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
      runFunction(pipeline, { event: prEvent, runId: "01REPOA" }),
      runFunction(pipeline, { event: other, runId: "01REPOB" }),
    ]);

    expect(count(api, "pnpm install")).toBe(2);
    expect(new Set(lockMachines(api).map((lock) => lock.name)).size).toBe(2);
  });
});

describe("a build that fails", () => {
  test("lets go of the lock, so the next run builds", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", exitCode: 1 }]);

    const { pipeline } = setup(api);

    const failed = await runFunction(pipeline, {
      event: prEvent,
      runId: "01FAILED",
    });

    expect(failed.type).toBe("function-rejected");
    expect(heldLocks(api)).toEqual([]);

    api.script([]);

    const next = await runFunction(pipeline, {
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

    const { pipeline } = setup(api);
    const results = await runs(pipeline, 3);

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    // No snapshot ever appears for the others to adopt, so each builds once it
    // holds the lock.
    expect(count(api, "pnpm install")).toBe(3);
    expect(heldLocks(api)).toEqual([]);
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

  test("the cleanup function releases it, and a waiting run then builds", async () => {
    const api = createFakeSandboxApi();
    const cacheKey = await learnLockName(api);

    plantLock(api, cacheKey, "01DEAD");

    const { ci, pipeline } = setup(api);
    let waits = 0;

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WAITER",
      resolveWait: async (step) => {
        if (step.displayName === "lock:wait") {
          waits++;

          // The dead run's cleanup comes in after the second wait.
          if (waits === 2) {
            await runFunction(cleanupOf(ci), {
              event: failedEvent(cacheKey, "01DEAD"),
            });
          }
        }

        return null;
      },
    });

    expect(result.type).toBe("function-resolved");
    expect(waits).toBe(2);
    expect(count(api, "pnpm install")).toBe(1);
    expect(heldLocks(api)).toEqual([]);
    expect(named(api)).toHaveLength(1);
  });

  test("the cleanup function leaves a lock that another run holds now", async () => {
    const api = createFakeSandboxApi();
    const cacheKey = await learnLockName(api);

    const id = plantLock(api, cacheKey, "01NEWER");
    const { ci } = setup(api);

    await runFunction(cleanupOf(ci), {
      event: failedEvent(cacheKey, "01DEAD"),
    });

    expect(api.sandboxes.get(id)?.status).toBe("RUNNING");
  });

  test("the platform reclaiming the machine releases it too", async () => {
    const api = createFakeSandboxApi();
    const cacheKey = await learnLockName(api);

    const id = plantLock(api, cacheKey, "01DEAD");
    const { pipeline } = setup(api);
    let waits = 0;

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WAITER",
      resolveWait: (step) => {
        if (step.displayName === "lock:wait") {
          waits++;

          // The longest a build may run has passed.
          if (waits === 3) {
            const stale = api.sandboxes.get(id);

            if (stale) {
              stale.status = "TERMINATED";
            }
          }
        }

        return null;
      },
    });

    expect(result.type).toBe("function-resolved");
    expect(waits).toBe(3);
    expect(count(api, "pnpm install")).toBe(1);
  });

  test("a lock that never lets go is built without after a while", async () => {
    const api = createFakeSandboxApi();
    const cacheKey = await learnLockName(api);

    const id = plantLock(api, cacheKey, "01DEAD");
    const { pipeline } = setup(api);

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01IMPATIENT",
      maxRequests: 2000,
    });

    expect(result.type).toBe("function-resolved");
    expect(count(api, "pnpm install")).toBe(1);
    expect(api.sandboxes.get(id)?.status).toBe("RUNNING");
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
