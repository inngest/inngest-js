/**
 * Tests of the build lock: runs that miss the same cached job ask for one
 * build, and every one of them adopts the snapshot from the event it ends with.
 * They run against the fake Sandboxes API, which holds a machine's name for as
 * long as the machine lives, and the event bus, which models a wait as a pause
 * that only events sent after it was saved can reach, and a function started by
 * an event with its singleton.
 *
 * @module
 */

import type { InngestFunction } from "inngest";
import { describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { lockMachineName, machineSetupScript } from "../machine/machine.ts";
import { busOf, createCiTestClient } from "../testing/client.ts";
import type { BusEvent } from "../testing/eventBus.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { buildDoneEvent, buildRequestedEvent } from "./buildLock.ts";
import { createCi } from "./createCi.ts";

type Api = ReturnType<typeof createFakeSandboxApi>;

const setup = (api: Api, app?: string) => {
  const client = createCiTestClient(api, app);
  const bus = busOf(client);

  if (!bus) {
    throw new Error("the test client has no bus");
  }

  const ci = createCi(client, { github: consoleReporter() });

  const install = ci.job({ id: "install", cache: { key: "v1" } }, async () => {
    await $`pnpm install`;
  });

  const pipeline = ci.pipeline({ id: "pr", on: prTrigger }, async () => {
    await install();
  });

  return { ci, pipeline, bus };
};

const installs = (api: Api): number => {
  return api.commands.filter((argv) => {
    return argv[2] !== machineSetupScript && argv.join(" ") === "pnpm install";
  }).length;
};

const locks = (api: Api) => {
  return [...api.sandboxes.values()].filter((machine) => {
    return machine.name.startsWith("ci-build-");
  });
};

const held = (api: Api) => {
  return locks(api).filter((machine) => {
    return machine.status !== "TERMINATED";
  });
};

const snapshots = (api: Api) => {
  return [...api.snapshots.values()].filter((snapshot) => {
    return snapshot.name;
  });
};

const sentOf = (bus: { sent: BusEvent[] }, name: string): BusEvent[] => {
  return bus.sent.filter((event) => {
    return event.name === name;
  });
};

const timeouts = (bus: { ended: string[] }): number => {
  return bus.ended.filter((how) => {
    return how === "timeout";
  }).length;
};

const runs = (pipeline: InngestFunction.Any, count: number, options = {}) => {
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

const functionOf = (ci: ReturnType<typeof setup>["ci"], id: string) => {
  const found = ci.functions().find((fn) => {
    // biome-ignore lint/suspicious/noExplicitAny: reading the function's options
    return (fn as any).opts.id === id;
  });

  if (!found) {
    throw new Error(`no function ${id}`);
  }

  return found;
};

/**
 * Run once and clear the fake, to have a genuine request and the event a build
 * ends with, and the snapshot it leaves, to plant later.
 */
const learn = async (api: Api) => {
  const { pipeline, bus, ci } = setup(api);

  await runFunction(pipeline, { event: prEvent, runId: "01LEARN" });

  const [snapshot] = snapshots(api);
  const request = sentOf(bus, buildRequestedEvent)[0];
  const done = sentOf(bus, buildDoneEvent)[0];

  api.snapshots.clear();
  api.sandboxes.clear();
  api.commands.length = 0;

  if (!snapshot || !request || !done) {
    throw new Error("the learning run left nothing to learn from");
  }

  return {
    ci,
    bus,
    snapshot,
    request,
    done,
    lock: lockMachineName(snapshot.name as string),
  };
};

/** A build lock held by a run that has since died. */
const plantLock = (api: Api, lock: string, owner: string): string => {
  const id = "99999999-9999-4999-8999-000000000001";

  api.sandboxes.set(id, {
    id,
    name: lock,
    status: "RUNNING",
    vcpu: 2,
    memoryMb: 2048,
    environment: { INNGEST_CI_LOCK_OWNER: owner },
  });

  return id;
};

const failedEvent = (request: BusEvent, owner: string) => {
  return {
    name: "inngest/function.failed",
    data: {
      function_id: "ci-test-ci/build",
      run_id: owner,
      event: { data: request.data },
    },
  };
};

describe("runs that miss the same cached job together", () => {
  test("one builds, every one adopts its snapshot, and nothing holds the lock afterwards", async () => {
    const api = createFakeSandboxApi();

    // A slow install keeps every run's lookup ahead of any snapshot.
    api.script([{ match: "pnpm install", ticks: 5 }]);

    const { pipeline, bus } = setup(api);
    const results = await runs(pipeline, 4);

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
      expect(new Set(result.stepIds).size).toBe(result.stepIds.length);
      expect(result.stepIds.join("\n")).not.toContain("alive");
    }

    expect(installs(api)).toBe(1);
    expect(snapshots(api)).toHaveLength(1);
    expect(held(api)).toEqual([]);

    // Four requests, one the build's: the singleton skipped the rest before
    // they started a run, and the builder's machine is owned by its run.
    expect(sentOf(bus, buildRequestedEvent)).toHaveLength(4);
    expect(bus.skipped).toBe(3);
    expect(locks(api)[0]?.environment).toEqual({
      INNGEST_CI_LOCK_OWNER: expect.stringMatching(/^01BUILD/),
    });

    const done = sentOf(bus, buildDoneEvent);

    expect(done).toHaveLength(1);
    expect(done[0]?.data.status).toBe("ready");
    expect(bus.ended.every((how) => how === "matched")).toBe(true);
  });

  test.each([
    ["apps", (event: typeof prEvent) => event, true],
    [
      "repositories",
      (event: typeof prEvent) => ({
        ...event,
        data: {
          ...event.data,
          repository: { full_name: "inngest/other" },
          pull_request: {
            ...event.data.pull_request,
            head: {
              ...event.data.pull_request.head,
              repo: { full_name: "inngest/other" },
            },
          },
        },
      }),
      false,
    ],
  ])(
    "%s with the same job and key don't block each other",
    async (_, change, apps) => {
      const api = createFakeSandboxApi();

      api.script([{ match: "pnpm install", ticks: 5 }]);

      const a = setup(api, apps ? "app-a" : undefined);
      const b = apps ? setup(api, "app-b") : a;

      await Promise.all([
        runFunction(a.pipeline, { event: prEvent, runId: "01A" }),
        runFunction(b.pipeline, { event: change(prEvent), runId: "01B" }),
      ]);

      expect(installs(api)).toBe(2);
      expect(new Set(locks(api).map((lock) => lock.name)).size).toBe(2);
      expect(held(api)).toEqual([]);
    },
  );

  test("a run that comes after the build finds the snapshot, builds nothing and asks for nothing", async () => {
    const api = createFakeSandboxApi();
    const { pipeline, bus } = setup(api);

    await runFunction(pipeline, { event: prEvent, runId: "01FIRST" });

    const before = sentOf(bus, buildRequestedEvent).length;
    const second = await runFunction(pipeline, {
      event: prEvent,
      runId: "01SECOND",
    });

    expect(second.type).toBe("function-resolved");
    expect(installs(api)).toBe(1);
    expect(sentOf(bus, buildRequestedEvent)).toHaveLength(before);
  });
});

describe("a build run handed a request", () => {
  test.each([
    ["another run holds the lock: it ends at once, and says nothing", true],
    ["the snapshot is already there: it builds nothing, and says so", false],
  ])("when %s", async (_, lockHeld) => {
    const api = createFakeSandboxApi();
    const { ci, bus, request, snapshot, lock } = await learn(api);

    if (lockHeld) {
      plantLock(api, lock, "01OTHER");
    } else {
      api.snapshots.set(snapshot.id, snapshot);
    }

    const before = bus.sent.length;
    const result = await runFunction(functionOf(ci, "ci/build"), {
      event: { name: request.name, data: request.data },
    });

    const told = sentOf({ sent: bus.sent.slice(before) }, buildDoneEvent);

    expect(result.type).toBe("function-resolved");
    expect(installs(api)).toBe(0);
    expect(told.map((event) => event.data.name)).toEqual(
      lockHeld ? [] : [lock],
    );
    expect(held(api)).toHaveLength(lockHeld ? 1 : 0);
  });
});

describe("the order of the wait, the look and the request", () => {
  test("a build that ends while the look runs is not built again, whichever of the two the run sees first", async () => {
    const api = createFakeSandboxApi();
    const { snapshot, done } = await learn(api);
    const { pipeline, bus } = setup(api);
    let calls = 0;

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01WOKEN",
      // The wait is saved and the look misses, then a build that finished
      // meanwhile takes its snapshot and sends its event.
      beforeRequest: () => {
        calls++;

        if (calls === 3) {
          api.snapshots.set(snapshot.id, snapshot);
          bus.send({ name: buildDoneEvent, data: done.data });
        }
      },
    });

    expect(result.type).toBe("function-resolved");
    expect(sentOf(bus, buildRequestedEvent).length).toBeLessThanOrEqual(1);
    expect(installs(api)).toBe(0);
    expect(timeouts(bus)).toBe(0);
  });

  test("an event from before the wait was saved is not delivered to it (no lookback), so the request finds the snapshot", async () => {
    const api = createFakeSandboxApi();
    const { snapshot, done } = await learn(api);
    const { pipeline, bus } = setup(api);

    // The build finished before this run's wait existed, and the run's look
    // missed the snapshot.
    bus.send({ name: buildDoneEvent, data: done.data });

    let shown = false;

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01LATE",
      beforeRequest: () => {
        // The snapshot is findable from the moment the request is sent.
        if (!shown && sentOf(bus, buildRequestedEvent).length > 0) {
          shown = true;
          api.snapshots.set(snapshot.id, snapshot);
        }
      },
    });

    expect(result.type).toBe("function-resolved");
    expect(sentOf(bus, buildRequestedEvent)).toHaveLength(1);
    expect(installs(api)).toBe(0);
    expect(timeouts(bus)).toBe(0);
  });
});

describe("a build that fails", () => {
  test("is asked for once more, and the second failure is the job's, with the builder's reason", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", exitCode: 1 }]);

    const { pipeline, bus } = setup(api);
    const failed = await runFunction(pipeline, {
      event: prEvent,
      runId: "01FAILED",
    });

    expect(failed.type).toBe("function-rejected");
    expect(String((failed.error as Error).message)).toContain(
      "The build of `install` failed",
    );
    expect(installs(api)).toBe(2);
    expect(held(api)).toEqual([]);

    // The second request has a key of its own, since the first build's run may
    // still be ending.
    const slots = sentOf(bus, buildRequestedEvent).map(
      (event) => event.data.slot,
    );

    expect(new Set(slots).size).toBe(2);
    expect(
      sentOf(bus, buildDoneEvent).map((event) => event.data.status),
    ).toEqual(["failed", "failed"]);
    expect(timeouts(bus)).toBe(0);
  });

  test("then a pass: every run that saw the failure asks again, and one build serves them", async () => {
    const api = createFakeSandboxApi();

    api.script([{ match: "pnpm install", exitCode: 1, ticks: 5 }]);

    const { pipeline, bus } = setup(api);

    const results = await runs(pipeline, 3, {
      beforeRequest: () => {
        // The first build has failed, so the next passes.
        if (sentOf(bus, buildDoneEvent).length > 0) {
          api.script([]);
        }
      },
    });

    for (const result of results) {
      expect(result.type).toBe("function-resolved");
    }

    expect(installs(api)).toBe(2);
    expect(snapshots(api)).toHaveLength(1);
    expect(held(api)).toEqual([]);
  });
});

describe("a build that died holding the lock", () => {
  test("the cleanup function releases it and sends a failed event, which wakes the waiting run to ask again", async () => {
    const api = createFakeSandboxApi();
    const { request, lock } = await learn(api);

    plantLock(api, lock, "01DEAD");

    const { ci, pipeline, bus } = setup(api);

    // The test acts as the platform, so it counts as a run that may still act.
    bus.enter();

    const waiter = runFunction(pipeline, { event: prEvent, runId: "01WAITER" });

    while (sentOf(bus, buildRequestedEvent).length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(installs(api)).toBe(0);

    await runFunction(functionOf(ci, "ci/build/cleanup"), {
      event: failedEvent(request, "01DEAD"),
    });

    bus.leave();

    expect((await waiter).type).toBe("function-resolved");
    expect(timeouts(bus)).toBe(0);
    expect(installs(api)).toBe(1);
    expect(held(api)).toEqual([]);
    expect(
      sentOf(bus, buildDoneEvent).map((event) => event.data.reason),
    ).toContain("the build run ended before it finished");
  });

  test.each([
    ["a lock another run holds now is left alone", "01NEWER", true],
    [
      "a build nobody else waits on has no lock to release and tells no one",
      "01DEAD",
      false,
    ],
  ])("%s", async (_, owner, locked) => {
    const api = createFakeSandboxApi();
    const { request, lock } = await learn(api);
    const id = plantLock(api, lock, owner);
    const { ci, bus } = setup(api);

    await runFunction(functionOf(ci, "ci/build/cleanup"), {
      event: failedEvent(
        {
          ...request,
          data: { ...request.data, locked: locked ? true : undefined },
        },
        "01DEAD",
      ),
    });

    expect(api.sandboxes.get(id)?.status).toBe("RUNNING");
    expect(sentOf(bus, buildDoneEvent).length).toBe(locked ? 1 : 0);
  });
});

describe("a wait that nothing ends", () => {
  test("with the lock alive, waits again however long it takes (past an hour here), and asks for nothing more", async () => {
    const api = createFakeSandboxApi();
    const { snapshot, done, lock } = await learn(api);

    plantLock(api, lock, "01SLOW");

    const { pipeline, bus } = setup(api);
    let finished = false;

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01PATIENT",
      beforeRequest: () => {
        // Four waits of fifteen minutes have run out, so the build has taken
        // longer than an hour, and then it ends.
        if (!finished && timeouts(bus) >= 4) {
          finished = true;
          api.snapshots.set(snapshot.id, snapshot);

          for (const machine of api.sandboxes.values()) {
            machine.status = "TERMINATED";
          }

          bus.send({ name: buildDoneEvent, data: done.data });
        }
      },
    });

    expect(result.type).toBe("function-resolved");
    expect(timeouts(bus)).toBeGreaterThanOrEqual(4);
    expect(sentOf(bus, buildRequestedEvent)).toHaveLength(1);
    expect(installs(api)).toBe(0);
  });

  test("with the lock gone, asks again", async () => {
    const api = createFakeSandboxApi();
    const { lock } = await learn(api);
    const id = plantLock(api, lock, "01LOST");
    const { pipeline, bus } = setup(api);

    const result = await runFunction(pipeline, {
      event: prEvent,
      runId: "01ASKS",
      beforeRequest: () => {
        // The platform reclaimed the lost build's machine.
        const stale = timeouts(bus) >= 1 ? api.sandboxes.get(id) : undefined;

        if (stale) {
          stale.status = "TERMINATED";
        }
      },
    });

    const slots = sentOf(bus, buildRequestedEvent).map(
      (event) => event.data.slot,
    );

    expect(result.type).toBe("function-resolved");
    expect(timeouts(bus)).toBe(1);
    expect(new Set(slots).size).toBe(2);
    expect(installs(api)).toBe(1);
  });
});

describe("builds that do not take the lock are invoked", () => {
  test.each([
    ["an uncached parent", false, "base (from) › build"],
    ["a cached job that starts from another", true, "test › build"],
  ])("%s", async (_, cached, invoked) => {
    const api = createFakeSandboxApi();
    const client = createCiTestClient(api);
    const ci = createCi(client, { github: consoleReporter() });
    const cache = cached ? { cache: { key: "v1" } } : {};

    const base = ci.job({ id: "base", ...cache }, async () => {
      await $`pnpm install`;
    });

    const child = ci.job({ id: "test", from: base, ...cache }, async () => {
      await $`pnpm test`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await child();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");
    expect(result.stepIds).toContain(invoked);
    expect(held(api)).toEqual([]);
  });
});

test("the fake's name rules: the same name and settings give the same machine back, other settings are refused, and ending the machine frees the name", async () => {
  const api = createFakeSandboxApi();

  const create = async (environment: Record<string, string>) => {
    const response = await api.fetch("http://sandboxes.test/v2/sandboxes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", vcpu: 1, memoryMb: 512, environment }),
    });

    return {
      status: response.status,
      body: (await response.json()) as {
        data?: { id: string };
        errors?: { code: string }[];
      },
    };
  };

  const first = await create({ LOCK: "a" });
  const again = await create({ LOCK: "a" });
  const other = await create({ LOCK: "b" });

  expect(first.status).toBe(201);
  expect(again.body.data?.id).toBe(first.body.data?.id);
  expect(other.status).toBe(409);
  expect(other.body.errors?.[0]?.code).toBe("sandbox_name_taken");

  await api.fetch(`http://sandboxes.test/v2/sandboxes/${first.body.data?.id}`, {
    method: "DELETE",
  });

  expect((await create({ LOCK: "b" })).status).toBe(201);
});
