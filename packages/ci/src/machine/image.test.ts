/**
 * Tests of base images: a job whose `from` is a snapshot captured by name,
 * alone, under a parent, and under a cached job.
 *
 * @module
 */

import { describe, expect, test } from "vitest";
import { CiUsageError } from "../errors.ts";
import { consoleReporter } from "../github/auth.ts";
import { image } from "../image.ts";
import { createCi } from "../pipeline/createCi.ts";
import { createCiTestClient } from "../testing/client.ts";
import { prEvent, prTrigger } from "../testing/events.ts";
import type { FakeSnapshot } from "../testing/fakeSandbox.ts";
import { createFakeSandboxApi } from "../testing/fakeSandbox.ts";
import { runFunction } from "../testing/runFunction.ts";
import { $ } from "./command.ts";
import { machineSetupScript } from "./machine.ts";

type Api = ReturnType<typeof createFakeSandboxApi>;
type Ci = ReturnType<typeof createCi>;

const setup = (
  api: Api,
  defaults: { from?: ReturnType<typeof image.snapshot> } = {},
) => {
  return createCi(createCiTestClient(api), {
    github: consoleReporter(),
    runUrl: ({ runId }) => {
      return `http://localhost:8288/run?runID=${runId}`;
    },
    ...defaults,
  });
};

let captured = 0;

/** Capture a named snapshot, as the Sandboxes API would. */
const capture = (api: Api, name: string): string => {
  captured += 1;

  const id = `00000000-0000-4000-8000-ffff${String(captured).padStart(8, "0")}`;

  api.snapshots.set(id, {
    id,
    name,
    status: "READY",
    sandboxId: "00000000-0000-4000-8000-0000000000aa",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  } as FakeSnapshot);

  return id;
};

/** The commands jobs ran, as text. */
const ran = (api: Api): string[] => {
  return api.commands
    .filter((argv) => {
      return argv[2] !== machineSetupScript;
    })
    .map((argv) => {
      return argv.join(" ");
    });
};

/** Run a pipeline whose body is given the CI client's jobs. */
const go = (ci: Ci, body: () => Promise<void>) => {
  return runFunction(ci.pipeline({ id: "pr", on: prTrigger }, body), {
    event: prEvent,
  });
};

const rejection = (result: Awaited<ReturnType<typeof go>>) => {
  return result.type === "function-rejected" ? result.error : undefined;
};

describe("a job on an image", () => {
  test("starts from the newest snapshot with exactly that name", async () => {
    const api = createFakeSandboxApi();
    const ci = setup(api);

    capture(api, "agent-deps-old");

    const id = capture(api, "agent-deps");

    const test = ci.job(
      { id: "test", from: image.snapshot("agent-deps") },
      async () => {
        await $`pnpm test`;
      },
    );

    const result = await go(ci, async () => {
      await test();
    });

    expect(result.type).toBe("function-resolved");
    expect(api.snapshotStarts).toEqual([id]);
    expect(ran(api)).toEqual(["pnpm test"]);
  });

  test("a createCi default applies, and a job's own image wins", async () => {
    const api = createFakeSandboxApi();
    const ci = setup(api, { from: image.snapshot("agent-deps") });
    const deps = capture(api, "agent-deps");
    const base = capture(api, "agent-base");

    const plain = ci.job("plain", async () => {
      await $`echo plain`;
    });

    const own = ci.job(
      { id: "own", from: image.snapshot("agent-base") },
      async () => {
        await $`echo own`;
      },
    );

    const matrix = ci.matrix({ id: "m", axes: { n: ["1"] } }, async () => {
      await $`echo matrix`;
    });

    const result = await go(ci, async () => {
      await plain();
      await own();
      await matrix();
    });

    expect(result.type).toBe("function-resolved");
    expect(api.snapshotStarts).toEqual([deps, base, deps]);
  });

  test("is found once however many jobs start from it", async () => {
    const api = createFakeSandboxApi();
    const ci = setup(api);

    capture(api, "agent-deps");

    const jobs = ["one", "two"].map((id) => {
      return ci.job({ id, from: image.snapshot("agent-deps") }, async () => {
        await $`echo ${id}`;
      });
    });

    const result = await go(ci, async () => {
      await Promise.all(
        jobs.map((job) => {
          return job();
        }),
      );
    });

    expect(result.type).toBe("function-resolved");

    expect(
      result.stepIds.filter((id) => id === "image agent-deps"),
    ).toHaveLength(1);
    expect(api.snapshotStarts).toHaveLength(2);
  });

  test("fails with a way to capture it when there is none", async () => {
    const api = createFakeSandboxApi();
    const ci = setup(api);

    const test = ci.job(
      { id: "test", from: image.snapshot("agent-deps") },
      async () => {
        await $`pnpm test`;
      },
    );

    const result = await go(ci, async () => {
      await test();
    });

    expect(rejection(result)).toMatchObject({
      name: "NonRetriableError",
      message:
        'No base image named `agent-deps`. Capture one with `sandbox.snapshot({ name: "agent-deps" })`.',
    });

    expect(api.sandboxes.size).toBe(0);
  });

  test("fails without rebuilding when the snapshot won't start", async () => {
    const api = createFakeSandboxApi();
    const ci = setup(api);

    capture(api, "agent-deps");
    api.failSnapshotStarts();

    const test = ci.job(
      { id: "test", from: image.snapshot("agent-deps") },
      async () => {
        await $`pnpm test`;
      },
    );

    const result = await go(ci, async () => {
      await test();
    });

    expect(rejection(result)).toMatchObject({
      name: "NonRetriableError",
      message: expect.stringContaining("The base image `agent-deps` wouldn't"),
    });

    expect(ran(api)).toEqual([]);
  });
});

describe("a parent on an image", () => {
  test.each([
    ["ran commands", "pnpm install", 2],
    ["ran none", undefined, 1],
  ])(
    "whose job %s passes the image to its child",
    async (_, command, starts) => {
      const api = createFakeSandboxApi();
      const ci = setup(api);
      const id = capture(api, "agent-deps");

      const parent = ci.job(
        { id: "parent", from: image.snapshot("agent-deps") },
        async () => {
          if (command) {
            await $`pnpm install`;
          }
        },
      );

      const child = ci.job({ id: "child", from: parent }, async () => {
        await $`pnpm test`;
      });

      const result = await go(ci, async () => {
        await child();
      });

      expect(result.type).toBe("function-resolved");
      expect(api.snapshotStarts[0]).toBe(id);
      expect(api.snapshotStarts).toHaveLength(starts);
      expect(ran(api)).toEqual([...(command ? [command] : []), "pnpm test"]);
    },
  );
});

describe("a cached job on an image", () => {
  /** Run the pipeline again, as a later run of the same app would. */
  const again = (
    api: Api,
    define: (ci: Ci) => () => Promise<void>,
  ): ReturnType<typeof go> => {
    const ci = setup(api);

    return go(ci, define(ci));
  };

  const cachedSetup = (ci: Ci) => {
    return ci.job(
      { id: "setup", from: image.snapshot("x"), cache: { key: "v1" } },
      async () => {
        await $`pnpm install`;
      },
    );
  };

  const named = (api: Api, job: string): Set<string> => {
    return new Set(
      [...api.snapshots.values()].flatMap((snapshot) => {
        return snapshot.name?.startsWith(`ci/pr:7/${job}/`)
          ? [snapshot.name]
          : [];
      }),
    );
  };

  test("hits again, and misses once the image is captured again", async () => {
    const api = createFakeSandboxApi();

    capture(api, "x");

    const run = async () => {
      const result = await again(api, (ci) => {
        const job = cachedSetup(ci);

        return async () => {
          await job();
        };
      });

      expect(result.type).toBe("function-resolved");

      return result;
    };

    await run();
    await run();

    expect(ran(api)).toEqual(["pnpm install"]);

    const recaptured = capture(api, "x");

    await run();

    expect(ran(api)).toEqual(["pnpm install", "pnpm install"]);
    expect(api.snapshotStarts.at(-1)).toBe(recaptured);
    expect(named(api, "setup").size).toBe(2);
  });

  test("starts its build from the image its name was worked out from, found once", async () => {
    const api = createFakeSandboxApi();
    const id = capture(api, "x");

    const result = await again(api, (ci) => {
      const job = cachedSetup(ci);

      return async () => {
        await job();
      };
    });

    expect(result.type).toBe("function-resolved");
    expect(api.snapshotStarts).toEqual([id]);
    expect(
      result.stepIds.filter((stepId) => stepId === "image x"),
    ).toHaveLength(1);
  });

  test("as a parent, gives its child a new name when the image changes", async () => {
    const api = createFakeSandboxApi();

    capture(api, "x");

    const run = () => {
      return again(api, (ci) => {
        const parent = cachedSetup(ci);

        const child = ci.job({ id: "child", from: parent }, async () => {
          await $`pnpm test`;
        });

        return async () => {
          await child();
        };
      });
    };

    await run();
    await run();

    expect(ran(api)).toEqual(["pnpm install", "pnpm test", "pnpm test"]);

    capture(api, "x");

    await run();

    expect(ran(api).filter((c) => c === "pnpm install")).toHaveLength(2);
    expect(named(api, "setup").size).toBe(2);
  });
});

describe("image.snapshot", () => {
  test.each([
    ["", /needs the name/],
    ["agent deps", /whitespace/],
    [" agent", /whitespace/],
    ["ci/pr:7/setup/abc", /belong to CI/],
  ])("%j throws at construction", (name, message) => {
    const make = () => {
      return image.snapshot(name);
    };

    expect(make).toThrow(CiUsageError);
    expect(make).toThrow(message);
  });

  test("makes a frozen value", () => {
    const value = image.snapshot("agent-deps");

    expect(value).toEqual({
      kind: "inngest/ci.image",
      source: "snapshot",
      name: "agent-deps",
    });

    expect(Object.isFrozen(value)).toBe(true);
  });
});
