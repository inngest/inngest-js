/**
 * Tests of pausing a finished job's machine in the background: a job doesn't
 * wait for its pause, `from()` and cleanup do, and a failed pause is a warning.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { consoleReporter } from "../github/auth.ts";
import { $ } from "../machine/command.ts";
import { from } from "../machine/from.ts";
import { destroyRunMachines } from "../machine/machine.ts";
import { pauseTiming } from "../machine/pause.ts";
import { createCiTestClient } from "../testing/client.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { createCi } from "./createCi.ts";
import { getRunScope } from "./scope.ts";

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

const setup = () => {
  const api = createFakeSandboxApi();

  const ci = createCi(createCiTestClient(api), { github: consoleReporter() });

  return { api, ci };
};

describe("background pause", () => {
  test("a leaf job ends without waiting for its pause", async () => {
    const { ci } = setup();

    const leaf = ci.job("leaf", async () => {
      await $`pnpm test`;
    });

    const next = ci.job("next", async () => {
      await $`pnpm lint`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await leaf();

        await next();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    // The next job's first step was found while the leaf's pause was still in
    // flight, so the two were reported together instead of one after the other.
    expect(result.batches).toContainEqual([
      "leaf › pause",
      "github › check:next:start",
    ]);
  });

  test("from() waits for the parent's pause, then resumes and snapshots", async () => {
    const { api, ci } = setup();

    const parent = ci.job("parent", async () => {
      await $`pnpm install`;
    });

    const child = ci.job("child", async () => {
      await from(parent);

      await $`pnpm test`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await Promise.all([parent(), child()]);
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    const order = result.stepIds.filter((id) => {
      return /^parent › (pause|resume|snapshot)$/.test(id);
    });

    expect(order).toEqual([
      "parent › pause",
      "parent › resume",
      "parent › snapshot",
    ]);

    const calls = api.requests
      .map((request) => {
        return /\/(pause|resume|snapshots)$/.exec(request)?.[1];
      })
      .filter(Boolean);

    expect(calls.slice(0, 3)).toEqual(["pause", "resume", "snapshots"]);
  });

  test("a failed background pause is a warning and the run passes", async () => {
    const { api, ci } = setup();

    api.failPauses();

    const leaf = ci.job("leaf", async () => {
      await $`pnpm test`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await leaf();

        const run = getRunScope();

        await Promise.all(run?.pauses.values() ?? []);

        return run?.warnings;
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    expect(result.data).toEqual([
      expect.stringContaining("Could not pause `leaf`"),
    ]);
  });

  test("step IDs are the same on every replay", async () => {
    const { ci } = setup();

    const leaf = ci.job("leaf", async () => {
      await $`pnpm test`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await leaf();
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-resolved");

    // Each step completes once. A replay that registered the pause under a
    // different ID, or twice, would show up as a second copy.
    expect(new Set(result.stepIds).size).toBe(result.stepIds.length);

    expect(
      result.stepIds.filter((id) => {
        return id === "leaf › pause";
      }),
    ).toHaveLength(1);
  });

  test("a failed run still reaches the pauses of jobs that finished", async () => {
    const { api, ci } = setup();

    api.script([{ match: "pnpm build", exitCode: 1, ticks: 2 }]);

    const done = ci.job("done", async () => {
      await $`pnpm test`;
    });

    const broken = ci.job("broken", async () => {
      await $`pnpm build`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger, retries: 0 }, async () => {
        await Promise.all([done(), broken()]);
      }),
      { event: prEvent },
    );

    expect(result.type).toBe("function-rejected");

    // The failure ends the run in whichever request it is replayed, so the
    // pause that an earlier request found has to be reached before it ends.
    expect(result.stepIds).toContain("done › pause");
  });

  test("cleanup destroys without waiting for in-flight pauses", async () => {
    const events: string[] = [];
    let finishPause = () => {};

    const pausing = new Promise<void>((resolve) => {
      finishPause = () => {
        events.push("paused");

        resolve();
      };
    });

    const run = {
      sandboxes: new Set(["a"]),
      pauses: new Map([["job", pausing]]),
      step: {
        run: (_options: unknown, fn: () => unknown) => {
          return fn();
        },
      },
      ci: {
        client: {
          sandboxes: {
            get: async () => {
              return {
                destroy: async () => {
                  events.push("destroyed");
                },
              };
            },
          },
        },
      },
      // biome-ignore lint/suspicious/noExplicitAny: a partial scope is enough here
    } as any;

    await destroyRunMachines(run);

    expect(events).toEqual(["destroyed"]);
    expect(run.destroyingMachines).toBe(true);

    finishPause();

    await pausing;

    expect(events).toEqual(["destroyed", "paused"]);
  });
});

describe("CI-owned pause step", () => {
  const original = { ...pauseTiming };

  beforeEach(() => {
    pauseTiming.pollMs = 10;
    pauseTiming.timeoutMs = 300;
  });

  afterEach(() => {
    Object.assign(pauseTiming, original);
  });

  const pauseOf = async (
    arrange: (api: ReturnType<typeof setup>["api"]) => void,
  ) => {
    const { api, ci } = setup();

    arrange(api);

    const leaf = ci.job("leaf", async () => {
      await $`pnpm test`;
    });

    const result = await runFunction(
      ci.pipeline({ id: "pr", on: prTrigger }, async () => {
        await leaf();

        const run = getRunScope();

        await Promise.all(run?.pauses.values() ?? []);

        return run?.warnings;
      }),
      { event: prEvent },
    );

    return result;
  };

  test("a normal pause reaches PAUSED", async () => {
    const result = await pauseOf((api) => {
      api.scriptPause(["PAUSING", "PAUSING", "PAUSED"]);
    });

    expect(result.data).toEqual([]);

    expect(result.steps["leaf › pause"]).toMatchObject({ paused: true });
  });

  test("a pause with no wait reaches PAUSED", async () => {
    const result = await pauseOf(() => {});

    expect(result.steps["leaf › pause"]).toMatchObject({ paused: true });
  });

  test("a sandbox destroyed while pausing succeeds quickly, not paused", async () => {
    const started = Date.now();

    const result = await pauseOf((api) => {
      api.scriptPause(["PAUSING", "TERMINATING", "TERMINATED"]);
    });

    expect(Date.now() - started).toBeLessThan(5_000);

    expect(result.type).toBe("function-resolved");

    expect(result.data).toEqual([]);

    expect(result.steps["leaf › pause"]).toEqual({
      paused: false,
      reason: "sandbox was cleaned up",
      seen: ["RUNNING", "PAUSING", "TERMINATING"],
    });
  });

  test("a pause refused because the sandbox is being torn down succeeds", async () => {
    const result = await pauseOf((api) => {
      api.conflictPauses();
    });

    expect(result.data).toEqual([]);

    expect(result.steps["leaf › pause"]).toMatchObject({
      paused: false,
      reason: "sandbox was cleaned up",
    });
  });

  test("a FAILED sandbox is a warning", async () => {
    const result = await pauseOf((api) => {
      api.scriptPause(["PAUSING", "FAILED"]);
    });

    expect(result.data).toEqual([
      expect.stringContaining("Could not pause `leaf`"),
    ]);
  });

  test("a sandbox still PAUSING at the timeout is a warning, not retried", async () => {
    let pauseRequests = () => {
      return 0;
    };

    const result = await pauseOf((api) => {
      api.scriptPause(["PAUSING"]);

      pauseRequests = () => {
        return api.requests.filter((request) => {
          return request.startsWith("POST ") && request.endsWith("/pause");
        }).length;
      };
    });

    expect(result.data).toEqual([
      expect.stringContaining("Could not pause `leaf`"),
    ]);

    expect(pauseRequests()).toBe(1);
  });

  test("the step keeps its ID", async () => {
    const result = await pauseOf(() => {});

    expect(result.stepIds).toContain("leaf › pause");
  });
});
