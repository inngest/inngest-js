/**
 * Tests for `image.job()`: a job starts from a job another app defines, which
 * that app builds and every asking app shares.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { consoleReporter } from "./github/auth.ts";
import { deployedRepo } from "./github/deployRepo.ts";
import { image } from "./image.ts";
import { $ } from "./machine/command.ts";
import { createCi } from "./pipeline/createCi.ts";
import { getRunScope } from "./pipeline/scope.ts";
import { createCiTestClient } from "./testing/client.ts";
import { prEvent, prTrigger } from "./testing/events.ts";
import { createFakeSandboxApi } from "./testing/fakeSandbox.ts";
import { runFunction } from "./testing/runFunction.ts";
import { fakeSchema } from "./testing/schema.ts";
import type { RepoContext } from "./types.ts";

vi.mock("./github/deployRepo.ts", () => {
  return { deployedRepo: vi.fn() };
});

const deployed: RepoContext = {
  owner: "acme",
  name: "platform",
  fullName: "acme/platform",
  sha: "a".repeat(40),
};

beforeEach(() => {
  vi.mocked(deployedRepo).mockReturnValue(deployed);
});

afterEach(() => {
  vi.mocked(deployedRepo).mockReset();
});

type Api = ReturnType<typeof createFakeSandboxApi>;

/** An app with its own client, on the environment `api` stands in for. */
const app = (api: Api, id: string) => {
  return createCi(createCiTestClient(api, id), { github: consoleReporter() });
};

/** How many commands containing `text` ran. */
const ran = (api: Api, text: string): number => {
  return api.commands.filter((argv) => {
    return argv.join(" ").includes(text);
  }).length;
};

/** Run `asker`'s pipeline with every app's functions in reach. */
const go = (
  asker: ReturnType<typeof app>,
  apps: ReturnType<typeof app>[],
  body: () => Promise<unknown>,
  runId = "01TESTRUN",
) => {
  return runFunction(asker.pipeline({ id: "pr", on: prTrigger }, body), {
    event: prEvent,
    runId,
    functions: apps.flatMap((ci) => {
      return ci.functions();
    }),
  });
};

/** `platform`'s cached `node-base`, and `web`'s `test` that starts from it. */
const world = (api: Api, key = "v1") => {
  const platform = app(api, "platform");
  const web = app(api, "web");

  platform.job({ id: "node-base", cache: { key } }, async () => {
    await $`pnpm install`;
  });

  const test = web.job(
    { id: "test", from: image.job("platform/node-base") },
    async () => {
      await $`pnpm test`;
    },
  );

  return { platform, web, test };
};

describe("image.job", () => {
  test.each([
    { ref: "platform", problem: "app/job" },
    { ref: "/node-base", problem: "app/job" },
    { ref: "platform/", problem: "app/job" },
    { ref: "plat form/node-base", problem: "app/job" },
  ])("$ref is not an app/job reference", ({ ref, problem }) => {
    expect(() => {
      image.job(ref);
    }).toThrow(problem);
  });

  test("an input gives the image a name of its own", () => {
    expect(image.job("platform/build").name).toBe("platform/build");
    expect(image.job("platform/build", "web").name).toMatch(
      /^platform\/build #[0-9a-f]{8}$/,
    );

    expect(image.job("platform/build", "web").name).not.toBe(
      image.job("platform/build", "api").name,
    );
  });

  test("a job starts from another app's job, which builds once and is found on every ask", async () => {
    const api = createFakeSandboxApi();

    for (const runId of ["01FIRST", "01SECOND"]) {
      const { platform, web, test } = world(api);

      const result = await go(
        web,
        [platform, web],
        async () => {
          await test();
        },
        runId,
      );

      expect(result.type).toBe("function-resolved");
    }

    expect(ran(api, "pnpm install")).toBe(1);
    expect(ran(api, "pnpm test")).toBe(2);

    const [snapshot, ...others] = [...api.snapshots.values()];

    expect(others).toEqual([]);

    expect(
      [...api.sandboxes.values()].filter((machine) => {
        return machine.snapshotId === snapshot?.id;
      }),
    ).toHaveLength(2);
  });

  test("a cached job on another app's job builds again when that job does", async () => {
    const api = createFakeSandboxApi();

    const run = async (key: string, runId: string) => {
      const platform = app(api, "platform");
      const web = app(api, "web");

      platform.job({ id: "node-base", cache: { key } }, async () => {
        await $`pnpm install`;
      });

      const deps = web.job(
        {
          id: "deps",
          from: image.job("platform/node-base"),
          cache: { key: "d1" },
        },
        async () => {
          await $`pnpm deps`;
        },
      );

      const result = await go(
        web,
        [platform, web],
        async () => {
          await deps();
        },
        runId,
      );

      expect(result.type).toBe("function-resolved");
    };

    await run("v1", "01A");
    await run("v1", "01B");

    expect(ran(api, "pnpm deps")).toBe(1);

    await run("v2", "01C");

    expect(ran(api, "pnpm install")).toBe(2);
    expect(ran(api, "pnpm deps")).toBe(2);
  });

  test("the other app's job is given the input and the repository it was deployed from", async () => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");
    const seen = new Set<string>();

    platform.job(
      {
        id: "build",
        input: fakeSchema<{ target: string }>({ target: "string" }),
        cache: { key: "v1" },
      },
      async ({ input: { target } }) => {
        seen.add(`${target} ${getRunScope()?.repo?.fullName}`);

        await $`pnpm build ${target}`;
      },
    );

    const test = web.job(
      { id: "test", from: image.job("platform/build", { target: "web" }) },
      async () => {
        await $`pnpm test`;
      },
    );

    const result = await go(web, [platform, web], async () => {
      await test();
    });

    expect(result.type).toBe("function-resolved");
    expect([...seen]).toEqual(["web acme/platform"]);
  });

  test("a job reached through a local parent starts from the image too", async () => {
    const api = createFakeSandboxApi();
    const { platform, web } = world(api);

    const deps = web.job(
      { id: "deps", from: image.job("platform/node-base") },
      async () => {
        await $`pnpm deps`;
      },
    );

    const lint = web.job({ id: "lint", from: deps }, async () => {
      await $`pnpm lint`;
    });

    const result = await go(web, [platform, web], async () => {
      await lint();
    });

    expect(result.type).toBe("function-resolved");
    expect(ran(api, "pnpm install")).toBe(1);
    expect(ran(api, "pnpm deps")).toBe(1);
    expect(ran(api, "pnpm lint")).toBe(1);
  });

  test("apps whose jobs start from each other fail with the cycle", async () => {
    const api = createFakeSandboxApi();
    const platform = app(api, "platform");
    const web = app(api, "web");

    platform.job({ id: "a", from: image.job("web/b") }, async () => {});
    web.job({ id: "b", from: image.job("platform/a") }, async () => {});

    const test = web.job(
      { id: "test", from: image.job("platform/a") },
      async () => {},
    );

    const result = await go(web, [platform, web], async () => {
      await test();
    });

    expect(result.type).toBe("function-rejected");

    expect(JSON.stringify(result.error)).toContain(
      "`platform/a` > `web/b` > `platform/a` starts from itself",
    );
  });

  test("a snapshot that won't start fails the job", async () => {
    const api = createFakeSandboxApi();

    {
      const { platform, web, test } = world(api);

      await go(web, [platform, web], async () => {
        await test();
      });
    }

    api.failSnapshotStarts();

    const { platform, web, test } = world(api);

    const result = await go(
      web,
      [platform, web],
      async () => {
        await test();
      },
      "01SECOND",
    );

    expect(result.type).toBe("function-rejected");

    expect(JSON.stringify(result.error)).toContain(
      "The snapshot of `platform/node-base` wouldn't start",
    );
  });
});
